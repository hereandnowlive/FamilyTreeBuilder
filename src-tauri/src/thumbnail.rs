//! Small preview copies of stored photos.
//!
//! A scanned slide can be over 20 megapixels. Showing a grid of those, or a
//! tree full of portraits, makes the webview decode every one at full size.
//! A thumbnail is a few hundred pixels across and decodes almost instantly.
//!
//! Thumbnails are a cache, not data: they are made on demand from the original
//! in the media folder, can be deleted at any time, and are left out of family
//! files. Like `family_file`, this module takes plain paths and knows nothing
//! about Tauri.

use std::error::Error;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder, ImageReader};

/// JPEG quality from 1 to 100. 80 is visually clean at thumbnail size.
const QUALITY: u8 = 80;

/// Writes a JPEG copy of `source` to `dest`, scaled down so that neither side
/// is longer than `max_edge` pixels. Smaller images are kept at their own size.
pub fn create(source: &Path, dest: &Path, max_edge: u32) -> Result<(), Box<dyn Error>> {
    // The format is detected from the file's first bytes rather than trusted
    // from its extension, so a PNG that was renamed to .jpg still opens.
    let mut decoder = ImageReader::open(source)?.with_guessed_format()?.into_decoder()?;

    // Cameras and phones often store a photo sideways and record the rotation
    // in its EXIF data. The webview applies that when it shows the original,
    // so the thumbnail has to apply it too or the two would disagree.
    // `orientation` comes from the `ImageDecoder` trait, which is why that trait
    // is imported above: a trait's methods are only callable while it is in scope.
    // https://doc.rust-lang.org/book/ch10-02-traits.html
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);

    if image.width() > max_edge || image.height() > max_edge {
        // Fits the image inside a max_edge square, keeping its proportions.
        image = image.thumbnail(max_edge, max_edge);
    }
    // JPEG has no transparency, so convert to plain RGB before encoding.
    let pixels = image.to_rgb8();

    // Written under a temporary name and renamed at the end, so a half-written
    // file is never mistaken for a finished thumbnail.
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);

    // `BufWriter` collects small writes in memory and sends them to disk in
    // large blocks, like wrapping a `FileStream` in a `BufferedStream` in C#.
    let mut out = BufWriter::new(File::create(&part)?);
    pixels.write_with_encoder(JpegEncoder::new_with_quality(&mut out, QUALITY))?;
    out.flush()?;
    // Closes the file now rather than at the end of the function. Windows will
    // not rename a file that is still open.
    drop(out);

    fs::rename(&part, dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    #[test]
    fn scales_large_images_down_and_leaves_small_ones_alone() {
        let dir = std::env::temp_dir().join(format!("family-tree-thumb-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        let wide = dir.join("wide.png");
        RgbImage::new(2000, 1000).save(&wide).unwrap();
        create(&wide, &dir.join("wide.jpg"), 480).unwrap();
        assert_eq!(image::image_dimensions(dir.join("wide.jpg")).unwrap(), (480, 240));
        assert!(!dir.join("wide.jpg.part").exists());

        let small = dir.join("small.png");
        RgbImage::new(100, 60).save(&small).unwrap();
        create(&small, &dir.join("small.jpg"), 480).unwrap();
        assert_eq!(image::image_dimensions(dir.join("small.jpg")).unwrap(), (100, 60));

        // A file that is not an image is an error, not a panic.
        let text = dir.join("notes.jpg");
        fs::write(&text, b"not an image").unwrap();
        assert!(create(&text, &dir.join("notes-thumb.jpg"), 480).is_err());

        fs::remove_dir_all(dir).unwrap();
    }
}
