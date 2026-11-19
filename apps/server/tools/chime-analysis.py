#!/usr/bin/env python3
"""
Measures reference sounds and writes the parameters the server's chime synthesiser plays (apps/server/assets/chimes/*.json).

    python3 -I apps/server/tools/chime-analysis.py <folder of reference .wav files> <output folder>

Needs numpy, scipy and miniaudio. Nothing of the recordings is kept: for each sound it stores only the tracks of its partials
(time, frequency and level of each sinusoid over time) and the shape of its overall loudness, a few kilobytes of numbers.
The synthesiser (src/lib/chimes.ts) plays them back with a small change of pitch and speed, so the chimes keep the character of
the references (pitch relations, rough or clean tone, rhythm, level) without being copies of them.
"""
import json, os, sys, glob
import numpy as np
import miniaudio

RATE = 44100
WINDOW = 8192          # 186 ms: long enough to separate partials that are 27 Hz apart
HOP = 441              # 10 ms
FFT = 32768
MAX_TRACKS = 30
LOW, HIGH = 80.0, 8000.0


def load(path):
    d = miniaudio.decode_file(path, output_format=miniaudio.SampleFormat.FLOAT32, nchannels=1, sample_rate=RATE)
    return np.array(d.samples, dtype=np.float64)


def frame_peaks(x, start, window):
    """Peaks of one frame as (frequency, amplitude) with parabolic interpolation, amplitude in the units of the signal."""
    seg = x[start:start + WINDOW]
    if len(seg) < WINDOW:
        seg = np.pad(seg, (0, WINDOW - len(seg)))
    spectrum = np.abs(np.fft.rfft(seg * window, n=FFT)) * 2 / window.sum()
    freqs = np.fft.rfftfreq(FFT, 1 / RATE)
    band = (freqs >= LOW) & (freqs <= HIGH)
    mag = np.where(band, spectrum, 0)
    left, mid, right = mag[:-2], mag[1:-1], mag[2:]
    idx = np.where((mid > left) & (mid >= right))[0] + 1
    out = []
    for i in idx:
        a, b, c = mag[i - 1], mag[i], mag[i + 1]
        denom = a - 2 * b + c
        shift = 0.5 * (a - c) / denom if denom != 0 else 0
        out.append((freqs[i] + shift * (freqs[1] - freqs[0]), b - 0.25 * (a - c) * shift))
    return out


def analyse(x):
    window = np.hanning(WINDOW)
    # Frames are centred on their time, so a sound that starts at 0 is seen from the start.
    padded = np.pad(x, (WINDOW // 2, WINDOW))
    frames = list(range(0, len(x), HOP))
    floor = np.abs(x).max() * 10 ** (-62 / 20)
    tracks, active = [], []
    for n, start in enumerate(frames):
        peaks = frame_peaks(padded, start, window)
        if not peaks:
            continue
        loudest = max(a for _, a in peaks)
        keep = sorted([(f, a) for f, a in peaks if a > max(floor, loudest * 10 ** (-42 / 20))], key=lambda p: -p[1])
        used = set()
        for f, a in keep:
            best, gap = None, 0.025
            for t in active:
                if id(t) in used or n - t["last"] > 3:
                    continue
                d = abs(f - t["f"][-1]) / t["f"][-1]
                if d < gap:
                    best, gap = t, d
            if best is None:
                best = {"n": [], "f": [], "a": [], "last": n}
                tracks.append(best)
                active.append(best)
            used.add(id(best))
            best["n"].append(n); best["f"].append(f); best["a"].append(a); best["last"] = n
        active = [t for t in active if n - t["last"] <= 3]
    tracks = [t for t in tracks if len(t["n"]) >= 4]
    for t in tracks:
        t["energy"] = float(np.sum(np.square(t["a"])))
    tracks.sort(key=lambda t: -t["energy"])
    return tracks[:MAX_TRACKS], frames


def smooth(values, width=3):
    pad = width // 2
    padded = np.pad(values, pad, mode="edge")
    return np.array([np.median(padded[i:i + width]) for i in range(len(values))])


def compact(track, frames):
    """Breakpoints every 20 ms, ending with a short fall to zero so a track never stops with a click."""
    n = np.array(track["n"]); f = np.array(track["f"]); a = smooth(np.array(track["a"]))
    points = []
    for i in range(0, len(n), 2):
        points.append([round(frames[n[i]] / RATE, 3), round(float(f[i]), 1), round(float(a[i]), 5)])
    last = len(n) - 1
    if (len(n) - 1) % 2:
        points.append([round(frames[n[last]] / RATE, 3), round(float(f[last]), 1), round(float(a[last]), 5)])
    points.append([round(points[-1][0] + 0.02, 3), points[-1][1], 0.0])
    return points


def loudness(x):
    """Overall loudness every 10 ms (RMS), which gives the synthesiser the attack and fall of the original sound."""
    n = len(x) // HOP
    rms = np.sqrt(np.square(x[:n * HOP]).reshape(n, HOP).mean(axis=1))
    return [round(float(v), 5) for v in rms]


def main():
    source, target = sys.argv[1], sys.argv[2]
    os.makedirs(target, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(source, "**", "*.wav"), recursive=True)):
        name = os.path.splitext(os.path.basename(path))[0]
        x = load(path)
        peak = float(np.abs(x).max())
        idx = np.where(np.abs(x) > peak * 10 ** (-48 / 20))[0]
        x = x[max(0, idx[0] - 441): idx[-1] + 1323]
        tracks, frames = analyse(x)
        data = {"duration": round(len(x) / RATE, 3), "peak": round(peak, 3), "loudness": loudness(x), "tracks": [compact(t, frames) for t in tracks]}
        with open(os.path.join(target, name + ".json"), "w") as out:
            json.dump(data, out, separators=(",", ":"))
        print(f"{name:28s} {len(tracks):2d} tracks  {data['duration']:.2f}s  {os.path.getsize(os.path.join(target, name + '.json')) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
