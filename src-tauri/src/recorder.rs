//! Records from the default microphone straight to an MP3 file.
//!
//! Three threads are involved:
//!
//! 1. The audio system's own thread calls our callback every few milliseconds
//!    with freshly captured samples. It must return quickly, so all it does is
//!    mix the samples down to mono and pass them on through a channel.
//! 2. A worker thread, started by [`Recorder::start`], owns the microphone
//!    stream, receives those samples, encodes them to MP3 and writes the file.
//! 3. The caller (a Tauri command) holds a [`Recorder`], which is just the
//!    handles needed to read the level meter and to stop the worker.
//!
//! The worker exists because the stream object must stay on the thread that
//! created it on some platforms, so it cannot be stored in app state directly.
//!
//! Threads and channels: https://doc.rust-lang.org/book/ch16-00-concurrency.html

use std::fmt::Display;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use mp3lame_encoder::{Bitrate, Builder, Encoder, FlushNoGap, MonoPcm, Quality};

/// 64 kbit/s is plenty for one voice in mono: about half a megabyte a minute.
const BITRATE: Bitrate = Bitrate::Kbps64;

const NO_MICROPHONE: &str =
    "No microphone was found. Plug one in, or check that it is enabled in your sound settings.";

/// A recording in progress. Dropping it without calling [`Recorder::finish`]
/// leaves the worker running, so always finish it.
pub struct Recorder {
    /// Set to true to ask the worker to stop.
    ///
    /// `Arc` is a reference-counted pointer that lets several threads own the
    /// same value, and `AtomicBool` is a bool that is safe to read and write
    /// from several threads at once without a lock. Together they are the
    /// lightest way to share a flag, close to a `volatile bool` field in C#.
    /// https://doc.rust-lang.org/std/sync/atomic/
    stop: Arc<AtomicBool>,
    /// Loudest sample since the meter was last read, stored as the bits of an `f32`.
    level: Arc<AtomicU32>,
    /// Handle for waiting on the worker and collecting its result,
    /// like holding on to a `Task<T>` in C# to await it later.
    worker: JoinHandle<Result<(), String>>,
}

impl Recorder {
    /// Opens the default microphone and starts writing an MP3 to `dest`.
    /// Returns once recording is really under way, or with the reason it could not start.
    pub fn start(dest: PathBuf) -> Result<Recorder, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let level = Arc::new(AtomicU32::new(0));

        // A one-off channel the worker uses to report whether the microphone
        // opened, so a missing microphone is an error here and not a silent
        // failure discovered only when the recording is stopped.
        let (ready_tx, ready_rx) = mpsc::channel();

        // `Arc::clone` copies the pointer, not the value: both ends now share
        // one flag. `move` hands the clones (and `dest`) over to the new thread.
        let worker = {
            let (stop, level) = (Arc::clone(&stop), Arc::clone(&level));
            thread::spawn(move || record(&dest, &stop, level, ready_tx))
        };

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Recorder { stop, level, worker }),
            Ok(Err(reason)) => Err(reason),
            // The sender was dropped without sending: the worker died early.
            Err(_) => Err("The recorder could not be started.".into()),
        }
    }

    /// The loudest level since the last call, from 0.0 (silence) to 1.0 (full
    /// scale). Reading it resets it, so each call covers a fresh stretch of time.
    pub fn take_level(&self) -> f32 {
        f32::from_bits(self.level.swap(0, Ordering::Relaxed))
    }

    /// Stops recording and waits until the file is completely written.
    ///
    /// Takes `self` by value, which consumes the recorder: the compiler will
    /// not let anyone use it again afterwards.
    /// https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html
    pub fn finish(self) -> Result<(), String> {
        self.stop.store(true, Ordering::Relaxed);
        // `join` blocks until the thread ends. Its outer `Result` is an error
        // only if the thread panicked; the inner one is what `record` returned.
        self.worker
            .join()
            .unwrap_or_else(|_| Err("The recorder stopped unexpectedly.".into()))
    }
}

/// The worker thread's whole job: capture, encode and write until told to stop.
fn record(
    dest: &Path,
    stop: &AtomicBool,
    level: Arc<AtomicU32>,
    ready: Sender<Result<(), String>>,
) -> Result<(), String> {
    // Everything that can fail before recording begins is reported through
    // `ready`, because `Recorder::start` is waiting on it.
    let (stream, samples, mut encoder, mut file) = match open(dest, level) {
        Ok(parts) => parts,
        Err(reason) => {
            let _ = ready.send(Err(reason.clone()));
            return Err(reason);
        }
    };
    let _ = ready.send(Ok(()));

    // Reused for every chunk so the loop does not allocate.
    let mut mp3 = Vec::new();

    while !stop.load(Ordering::Relaxed) {
        // Wait for samples, but wake up regularly to check the stop flag.
        match samples.recv_timeout(Duration::from_millis(50)) {
            Ok(chunk) => encode(&mut encoder, &chunk, &mut mp3, &mut file)?,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("The microphone stopped unexpectedly.".into()),
        }
    }

    // Dropping the stream closes the microphone. Whatever it had already sent
    // is still waiting in the channel, so encode that before finishing.
    drop(stream);
    for chunk in samples.try_iter() {
        encode(&mut encoder, &chunk, &mut mp3, &mut file)?;
    }

    // The encoder holds back a little audio internally; flushing writes it out.
    mp3.clear();
    mp3.reserve(mp3lame_encoder::max_required_buffer_size(0));
    encoder.flush_to_vec::<FlushNoGap>(&mut mp3).map_err(text)?;
    file.write_all(&mp3).map_err(text)?;
    file.flush().map_err(text)
}

/// The four things recording needs, bundled so [`open`] can return them together.
type Session = (Stream, Receiver<Vec<f32>>, Encoder, BufWriter<File>);

/// Opens the default microphone, the MP3 encoder and the output file.
fn open(dest: &Path, level: Arc<AtomicU32>) -> Result<Session, String> {
    let device = cpal::default_host().default_input_device().ok_or(NO_MICROPHONE)?;
    let supported = device.default_input_config().map_err(|_| NO_MICROPHONE)?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let channels = usize::from(config.channels);

    let mut builder = Builder::new().ok_or("The MP3 encoder could not be started.")?;
    builder.set_num_channels(1).map_err(text)?;
    builder.set_sample_rate(config.sample_rate).map_err(text)?;
    builder.set_brate(BITRATE).map_err(text)?;
    builder.set_quality(Quality::Good).map_err(text)?;
    let encoder = builder.build().map_err(text)?;

    let file = BufWriter::new(File::create(dest).map_err(text)?);

    // Microphones deliver samples as different number types. Each arm calls the
    // same generic function with the matching type filled in.
    let (tx, rx) = mpsc::channel();
    let stream = match format {
        SampleFormat::F32 => capture::<f32>(&device, config, channels, tx, level),
        SampleFormat::I16 => capture::<i16>(&device, config, channels, tx, level),
        SampleFormat::U16 => capture::<u16>(&device, config, channels, tx, level),
        SampleFormat::I32 => capture::<i32>(&device, config, channels, tx, level),
        other => Err(format!("This microphone's audio format ({other}) is not supported.")),
    }?;
    stream.play().map_err(text)?;

    Ok((stream, rx, encoder, file))
}

/// Starts capturing samples of type `T` and forwarding them as mono `f32`.
///
/// This is a generic function, like `Capture<T>()` in C#. The `where` clause
/// lists what `T` must be able to do: be a sample type cpal can deliver, and be
/// convertible to `f32`. The compiler generates one copy per type it is called with.
/// https://doc.rust-lang.org/book/ch10-01-syntax.html
fn capture<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channels: usize,
    samples: Sender<Vec<f32>>,
    level: Arc<AtomicU32>,
) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            config,
            // The capture callback. `data` holds the channels interleaved
            // (left, right, left, right...), so each chunk of `channels`
            // values is one moment in time, averaged here into one mono value.
            move |data: &[T], _| {
                let mono: Vec<f32> = data
                    .chunks(channels)
                    .map(|frame| frame.iter().map(|&s| f32::from_sample(s)).sum::<f32>() / channels as f32)
                    .collect();

                let peak = mono.iter().fold(0.0_f32, |max, s| max.max(s.abs()));
                // For non-negative floats, a bigger number has a bigger bit
                // pattern, so `fetch_max` on the raw bits keeps the loudest peak
                // without needing a lock.
                level.fetch_max(peak.to_bits(), Ordering::Relaxed);

                // Sending only fails once the worker has gone, and then there
                // is nobody left to tell.
                let _ = samples.send(mono);
            },
            |error| eprintln!("microphone error: {error}"),
            None,
        )
        .map_err(text)
}

/// Encodes one chunk of samples and appends the resulting MP3 data to the file.
fn encode(encoder: &mut Encoder, chunk: &[f32], mp3: &mut Vec<u8>, file: &mut impl Write) -> Result<(), String> {
    mp3.clear();
    mp3.reserve(mp3lame_encoder::max_required_buffer_size(chunk.len()));
    encoder.encode_to_vec(MonoPcm(chunk), mp3).map_err(text)?;
    file.write_all(mp3).map_err(text)
}

/// Turns any printable error into the `String` this module reports errors as.
fn text(error: impl Display) -> String {
    error.to_string()
}
