# Texture attribution

## `paper.png`

Tileable kraft paper.

- **Source:** [Kraft tileable 1024x1024.png](https://commons.wikimedia.org/wiki/File:Kraft_tileable_1024x1024.png)
  on Wikimedia Commons
- **Author:** Coyau (own work)
- **License:** Public domain

Processed for use as a UI surface: downscaled 1024 → 384, converted to
grayscale (the texture is tinted at paint time, so colour in the asset would
only fight the theme), and contrast reduced so it reads as grain rather than as
pattern. 1.5 MB → 72 KB.

Regenerate from the original with:

```
ffmpeg -i kraft-raw.png \
  -vf "scale=384:384,format=gray,eq=contrast=0.72:brightness=0.06" \
  -compression_level 100 paper.png
```
