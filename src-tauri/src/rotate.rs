//! Turning a stored photo by a quarter turn and saving it that way.
//!
//! The turned picture is written as a new file; the caller swaps it in and
//! deletes the old one. Like `thumbnail`, this module takes plain paths and
//! knows nothing about Tauri.
//!
//! JPEG is a lossy format: saving one again loses a very small amount of
//! detail each time, however high the quality setting. `JPEG_QUALITY` is set
//! high enough that a few turns are not visible, but it is why the app offers
//! a button for each direction rather than making the user go round three
//! times to turn a photo left. PNG, BMP and WebP are saved without any loss.

use std::error::Error;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use image::codecs::bmp::BmpEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{ColorType, DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};

/// JPEG quality from 1 to 100 for the re-saved photo. Much higher than a
/// thumbnail's, because this file replaces the original.
const JPEG_QUALITY: u8 = 95;

const UNSUPPORTED: &str = "This kind of image cannot be rotated in the app. JPEG, PNG, BMP and WebP photos can.";

/// Reads the photo at `source`, turns it a quarter turn, and writes it into
/// `dest_dir` under the name `stem` plus the right extension for its format.
/// Returns the new file's name. `source` is not changed.
///
/// The return type's error is `Box<dyn Error>`, "any error at all", as in
/// `family_file.rs`.
pub fn rotate(source: &Path, dest_dir: &Path, stem: &str, clockwise: bool) -> Result<String, Box<dyn Error>> {
    // The format is detected from the file's first bytes rather than trusted
    // from its extension, and the new file is given the extension that
    // matches, so a PNG that was renamed to .jpg comes out as a real .png.
    let reader = ImageReader::open(source)?.with_guessed_format()?;
    let format = reader.format().ok_or(UNSUPPORTED)?;
    let extension = match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Png => "png",
        ImageFormat::Bmp => "bmp",
        ImageFormat::WebP => "webp",
        // `_` is the catch-all arm, like `default:` in a C# switch. A GIF
        // lands here: it may be animated, which a re-save would flatten.
        _ => return Err(UNSUPPORTED.into()),
    };

    let mut decoder = reader.into_decoder()?;
    // The colour profile says how the photo's colours should be shown.
    // Carrying it over keeps a scan's colours from shifting.
    let colour_profile = decoder.icc_profile()?;
    // A camera may have stored the photo sideways with a note in its EXIF data
    // saying which way is up. Apply that first, so the turn starts from what
    // the user actually sees. The note is not written to the new file, whose
    // pixels are now simply the right way round.
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);

    let image = if clockwise { image.rotate90() } else { image.rotate270() };

    // Each format can only store certain kinds of pixel. Anything else (16-bit
    // colour, or transparency in a format without it) is converted to the
    // nearest kind the format takes. A tuple lets `match` test two values at once.
    let has_alpha = image.color().has_alpha();
    let image = match (format, image.color()) {
        (ImageFormat::Png, _) => image,
        (ImageFormat::Jpeg | ImageFormat::Bmp, ColorType::L8 | ColorType::Rgb8) => image,
        (ImageFormat::Bmp | ImageFormat::WebP, _) if has_alpha => DynamicImage::ImageRgba8(image.to_rgba8()),
        _ => DynamicImage::ImageRgb8(image.to_rgb8()),
    };

    let file_name = format!("{stem}.{extension}");
    let dest = dest_dir.join(&file_name);
    // Written under a temporary name and renamed at the end, so a half-written
    // file is never mistaken for a finished photo.
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut out = BufWriter::new(File::create(&part)?);

    // The encoders are different types, so each arm builds its own and writes
    // with it. `set_icc_profile` fails for a format that cannot hold a
    // profile; `let _ =` says that is fine and the result can be ignored.
    let written = match format {
        ImageFormat::Jpeg => {
            let mut encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
            if let Some(profile) = colour_profile {
                let _ = encoder.set_icc_profile(profile);
            }
            image.write_with_encoder(encoder)
        }
        ImageFormat::Png => {
            let mut encoder = PngEncoder::new(&mut out);
            if let Some(profile) = colour_profile {
                let _ = encoder.set_icc_profile(profile);
            }
            image.write_with_encoder(encoder)
        }
        ImageFormat::Bmp => image.write_with_encoder(BmpEncoder::new(&mut out)),
        _ => image.write_with_encoder(WebPEncoder::new_lossless(&mut out)),
    };
    // Finish and close the file whether or not the write worked: Windows will
    // not rename or delete a file that is still open.
    let flushed = out.flush();
    drop(out);

    // `and_then` runs the rename only if everything before it succeeded.
    let result = written
        .map_err(Box::<dyn Error>::from)
        .and_then(|()| Ok(flushed?))
        .and_then(|()| Ok(fs::rename(&part, &dest)?));
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result.map(|()| file_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("family-tree-rotate-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn turns_a_photo_each_way_without_touching_the_original() {
        let dir = temp_dir();
        // 20 wide, 10 high, with one red pixel in the top left corner.
        let mut picture = RgbImage::new(20, 10);
        picture.put_pixel(0, 0, Rgb([255, 0, 0]));
        let source = dir.join("photo.png");
        picture.save(&source).unwrap();

        let right = rotate(&source, &dir, "right", true).unwrap();
        assert_eq!(right, "right.png");
        let turned = image::open(dir.join(&right)).unwrap().to_rgb8();
        assert_eq!(turned.dimensions(), (10, 20));
        // Clockwise, the top left corner ends up top right.
        assert_eq!(turned.get_pixel(9, 0), &Rgb([255, 0, 0]));

        let left = rotate(&source, &dir, "left", false).unwrap();
        let turned = image::open(dir.join(&left)).unwrap().to_rgb8();
        // Anticlockwise, it ends up bottom left.
        assert_eq!(turned.get_pixel(0, 19), &Rgb([255, 0, 0]));

        assert_eq!(image::image_dimensions(&source).unwrap(), (20, 10));
        assert!(!dir.join("right.png.part").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn names_the_new_file_after_what_the_photo_really_is() {
        let dir = temp_dir();
        // A JPEG saved under a .png name.
        let honest = dir.join("honest.jpg");
        RgbImage::new(8, 4).save(&honest).unwrap();
        let disguised = dir.join("disguised.png");
        fs::rename(&honest, &disguised).unwrap();

        let name = rotate(&disguised, &dir, "turned", true).unwrap();
        assert_eq!(name, "turned.jpg");
        assert_eq!(image::image_dimensions(dir.join(name)).unwrap(), (4, 8));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_what_it_cannot_save_again() {
        let dir = temp_dir();
        let gif = dir.join("moving.gif");
        RgbImage::new(4, 4).save(&gif).unwrap();
        assert_eq!(rotate(&gif, &dir, "turned", true).unwrap_err().to_string(), UNSUPPORTED);

        let text = dir.join("notes.jpg");
        fs::write(&text, b"not an image").unwrap();
        assert!(rotate(&text, &dir, "turned", true).is_err());

        // Nothing was left behind by either attempt.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(dir).unwrap();
    }
}
