# Video fixtures

`sample.webm` (VP8) and `sample.mp4` (H.264/YUV420P) are generated one-second, silent 160×90 solid-color clips. They contain no third-party media. They exercise actual fileinfo detection, protected streaming, byte ranges and browser playback without requiring FFmpeg in CI or production.

To regenerate with FFmpeg (run from the repository root):

```sh
ffmpeg -f lavfi -i 'color=c=0x397bb5:s=160x90:r=10:d=1' -an -c:v libvpx -b:v 50k tests/fixtures/sample.webm
ffmpeg -f lavfi -i 'color=c=0x397bb5:s=160x90:r=10:d=1' -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart tests/fixtures/sample.mp4
```


## Audio fixtures

`sample.mp3`, `.mp2`, `.flac`, `.wav`, `.ogg`, `.opus`, `.m4a`, `.aac`,
`.aiff`, `.wma`, `.weba` are generated 0.4-second 440 Hz sine tones, not
third-party recordings. They test fileinfo, inline MIME, ranges and actual
WAV browser playback. CI/production do not require FFmpeg. Regeneration:

```sh
# EXT/CODEC: mp3/libmp3lame, mp2/mp2, flac/flac, wav/pcm_s16le,
# ogg/libvorbis, opus/libopus, m4a/aac, aac/aac, aiff/pcm_s16be, wma/wmav2
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.4' -c:a CODEC tests/fixtures/sample.EXT
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.4' -c:a libopus -f webm tests/fixtures/sample.weba
```
