"""Package only the unpacked extension's runtime files; never collect a profile or key."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "manifest.json", "options.html", "popup.html", "pdf.html", "README.md", "测试记录.md",
    "src/shared.js", "src/ai.js", "src/background.js",
    "src/translator.js", "src/free-translators.js",
    "src/libretranslate.js",
    "src/content.js", "src/content.css", "src/options.js", "src/popup.js", "src/ui.css",
    "src/pdf-entry.js", "src/pdf-model.js", "src/pdf.js", "src/pdf.css",
]

def main():
    vendor = ROOT / "vendor" / "pdfjs"
    for name in ["pdf.mjs", "pdf.worker.mjs", "LICENSE"]:
        if not (vendor / name).is_file():
            raise FileNotFoundError(vendor / name)
    files = FILES + sorted(path.relative_to(ROOT).as_posix() for path in vendor.rglob("*") if path.is_file())
    for name in files:
        if not (ROOT / name).is_file():
            raise FileNotFoundError(name)
    destination = ROOT / "dist" / "沉浸式翻译.zip"
    destination.parent.mkdir(exist_ok=True)
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(ROOT / name, name)
    print(f"Packaged {len(files)} files: {destination}")

if __name__ == "__main__":
    main()
