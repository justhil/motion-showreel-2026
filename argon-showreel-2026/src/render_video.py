import concurrent.futures
import http.server
import os
import shutil
import socketserver
import subprocess
import sys
import time
import threading
from PIL import Image
from playwright.sync_api import sync_playwright

EDGE_PATH = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
FRAMES_DIR = "frames"
OUTPUT_DIR = "output"
TOTAL_FRAMES = 900
WORKERS = 4

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

def render_chunk(args):
    worker_id, start_f, end_f, port = args
    t0 = time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=EDGE_PATH,
            headless=True,
            args=["--disable-dev-shm-usage", "--enable-gpu-rasterization"]
        )
        page = browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"http://127.0.0.1:{port}/index.html?render=1", wait_until="networkidle")
        page.wait_for_function("window.REEL_READY === true", timeout=15000)

        for f in range(start_f, end_f):
            page.evaluate(f"window.seekToFrame({f})")
            out_path = os.path.join(FRAMES_DIR, f"frame_{f:04d}.png")
            page.screenshot(path=out_path, type="png")

        browser.close()
    dt = time.time() - t0
    if errors:
        raise RuntimeError(f"Worker {worker_id} encountered page errors: {errors}")
    return f"Worker {worker_id}: rendered frames [{start_f}..{end_f - 1}] in {dt:.2f}s ({(end_f - start_f)/dt:.1f} fps)"

def build_contact_sheet():
    pick = [24, 95, 158, 235, 302, 345, 425, 545, 638, 682, 738, 855]
    cols, rows = 4, 3
    tw, th = 480, 270
    sheet = Image.new("RGB", (cols * tw, rows * th), (15, 22, 18))
    for idx, f in enumerate(pick):
        im = Image.open(os.path.join(FRAMES_DIR, f"frame_{f:04d}.png")).convert("RGB")
        im_small = im.resize((tw, th), Image.Resampling.LANCZOS)
        r, c = divmod(idx, cols)
        sheet.paste(im_small, (c * tw, r * th))
    sheet.save(os.path.join(OUTPUT_DIR, "storyboard_sheet.png"), optimize=True)

def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    server = ThreadedHTTPServer(("127.0.0.1", 0), QuietHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    t_start = time.time()
    chunk = TOTAL_FRAMES // WORKERS
    tasks = []
    for w in range(WORKERS):
        s = w * chunk
        e = TOTAL_FRAMES if w == WORKERS - 1 else (w + 1) * chunk
        tasks.append((w, s, e, port))

    print(f"Starting {WORKERS}-worker parallel render of {TOTAL_FRAMES} lossless 1080p frames on port {port}...")
    with concurrent.futures.ProcessPoolExecutor(max_workers=WORKERS) as ex:
        for msg in ex.map(render_chunk, tasks):
            print(" ", msg)

    server.shutdown()

    # Verify all 900 PNG frames exist and are non-empty
    missing = []
    for f in range(TOTAL_FRAMES):
        fp = os.path.join(FRAMES_DIR, f"frame_{f:04d}.png")
        if not os.path.exists(fp) or os.path.getsize(fp) < 5000:
            missing.append(f)
    if missing:
        raise RuntimeError(f"Missing or corrupt frames: {missing[:10]}")

    t_frames = time.time() - t_start
    print(f"All {TOTAL_FRAMES} lossless 1080p frames verified in {t_frames:.2f}s ({TOTAL_FRAMES/t_frames:.1f} effective fps).")

    # Copy poster frame (Act 3 3D explosion & Act 6 Résumé Slate)
    shutil.copy2(os.path.join(FRAMES_DIR, "frame_0855.png"), os.path.join(OUTPUT_DIR, "poster_slate.png"))
    shutil.copy2(os.path.join(FRAMES_DIR, "frame_0425.png"), os.path.join(OUTPUT_DIR, "poster_3d.png"))
    build_contact_sheet()

    # Encode Master MP4 via FFmpeg (High Profile H.264 CRF 15 + 320kbps 48kHz AAC)
    mp4_path = os.path.join(OUTPUT_DIR, "argon_showreel_2026.mp4")
    cmd = [
        "ffmpeg", "-y",
        "-framerate", "60",
        "-i", os.path.join(FRAMES_DIR, "frame_%04d.png"),
        "-i", "assets/audio/soundtrack.wav",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-preset", "slow",
        "-crf", "15",
        "-profile:v", "high",
        "-level:v", "4.2",
        "-pix_fmt", "yuv420p",
        "-r", "60",
        "-c:a", "aac",
        "-b:a", "320k",
        "-ar", "48000",
        "-movflags", "+faststart",
        "-shortest",
        mp4_path
    ]
    print("Encoding H.264/AAC Master MP4...")
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stderr)
        sys.exit(res.returncode)

    print(f"Master MP4 encoded successfully -> {mp4_path} ({os.path.getsize(mp4_path)/(1024*1024):.2f} MB)")

if __name__ == "__main__":
    main()
