# build_exe.ps1
# PowerShell script to build the VolleyballAnalytics executable using PyInstaller

uv run pyinstaller --noconfirm --onedir --windowed `
  --name "Volleyball Playtime Extractor" `
  --icon "assets/volleyball_app.ico" `
  --add-data "models;models" `
  --add-data "src;src" `
  --add-data "bin/ffmpeg.exe;bin" `
  --add-data "bin/ffprobe.exe;bin" `
  --add-data "assets/volleyball_app.ico;assets" `
  --collect-all ultralytics `
  --collect-all openvino `
  --collect-all cv2 `
  gui.py