param(
    [string]$SourceImage = (Join-Path $PSScriptRoot '../assets/icons/logo-source.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../assets/icons'))
[System.IO.Directory]::CreateDirectory($iconDirectory) | Out-Null
$sourceBitmap = [System.Drawing.Image]::FromFile([System.IO.Path]::GetFullPath($SourceImage))
try {
    foreach ($iconSize in @(16, 32, 48, 128, 256)) {
        $iconBitmap = [System.Drawing.Bitmap]::new($iconSize, $iconSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
        try {
            $iconGraphics.Clear([System.Drawing.Color]::Transparent)
            $iconGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $iconGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $iconGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $iconGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $iconGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $iconRectangle = [System.Drawing.Rectangle]::new(0, 0, $iconSize, $iconSize)
            $iconGraphics.DrawImage($sourceBitmap, $iconRectangle, 0, 0, $sourceBitmap.Width, $sourceBitmap.Height, [System.Drawing.GraphicsUnit]::Pixel)
            $iconBitmap.Save((Join-Path $iconDirectory "icon-$iconSize.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $iconGraphics.Dispose()
            $iconBitmap.Dispose()
        }
    }
} finally {
    $sourceBitmap.Dispose()
}
Write-Output 'Built PNG icons: 16, 32, 48, 128, 256 px.'
