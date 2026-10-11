import { useEffect, useState, type ComponentProps } from "react";
import { cachedThumbnailUrl, thumbnailUrl } from "../db";

/** URL of the small preview of a stored photo, or undefined until it is ready (or when there is no photo). */
export function useThumbnail(fileName: string | null): string | undefined {
  const [url, setUrl] = useState(() => (fileName ? cachedThumbnailUrl(fileName) : undefined));

  useEffect(() => {
    if (!fileName) return setUrl(undefined);
    let current = true;
    setUrl(cachedThumbnailUrl(fileName));
    thumbnailUrl(fileName).then((ready) => current && setUrl(ready));
    return () => {
      current = false;
    };
  }, [fileName]);

  return url;
}

/** An <img> showing the small preview of a stored photo. Use mediaUrl() where the full image is wanted. */
export function Thumbnail({ fileName, alt, ...props }: { fileName: string } & ComponentProps<"img">) {
  const src = useThumbnail(fileName);
  // Without a src, an empty alt keeps the browser from drawing a broken-image placeholder.
  return <img src={src} alt={src ? alt : ""} loading="lazy" decoding="async" draggable={false} {...props} />;
}
