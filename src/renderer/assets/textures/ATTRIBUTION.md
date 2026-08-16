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

## `blueprint.jpg`

Cyanotype paper, used as the sheet-mode canvas board.

- **Source:** [Blueprint - Hallwylska museet - 101011.tif](https://commons.wikimedia.org/wiki/File:Blueprint_-_Hallwylska_museet_-_101011.tif)
  on Wikimedia Commons - a 1920 architectural cyanotype
- **Author:** Hallwyl Museum
- **License:** Public domain

A blank region of the blue field was cropped away from any drawing, then
mirrored horizontally and vertically into a 2x2 so the tile repeats seamlessly
across an infinitely pannable canvas. A straight crop of a scan does not tile;
mirroring is what makes real paper grain usable as a background.

```
ffmpeg -i bp-src.jpg -vf "crop=240:110:640:575" bp-crop.png
ffmpeg -i bp-crop.png -filter_complex   "[0]split=4[a][b][c][d];[b]hflip[bh];[c]vflip[cv];[d]hflip,vflip[dhv];   [a][bh]hstack[top];[cv][dhv]hstack[bot];[top][bot]vstack[out]"   -map "[out]" bp-tile.png
ffmpeg -i bp-tile.png -q:v 4 blueprint.jpg
```
