# Video fixtures

`sample.webm` (VP8) and `sample.mp4` (H.264/YUV420P) are generated one-second, silent 160×90 solid-color clips. They contain no third-party media. They exercise actual fileinfo detection, protected streaming, byte ranges and browser playback without requiring FFmpeg in CI or production.

To regenerate with FFmpeg (run from the repository root):

```sh
ffmpeg -f lavfi -i 'color=c=0x397bb5:s=160x90:r=10:d=1' -an -c:v libvpx -b:v 50k tests/fixtures/sample.webm
ffmpeg -f lavfi -i 'color=c=0x397bb5:s=160x90:r=10:d=1' -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart tests/fixtures/sample.mp4
```
