# Minimal static file server for local testing: http://localhost:8080
# Usage:  powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080]
# Also accepts PUT /data/<file> so tools/build-index.html can save the card index.
param([int]$Port = 8080)

$root = $PSScriptRoot
$dataDir = Join-Path $root 'data'
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.webp' = 'image/webp'
  '.bin' = 'application/octet-stream'; '.md' = 'text/markdown; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "PokeScan running at http://localhost:$Port  (Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
      if ($path -eq '') { $path = 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))

      if ($req.HttpMethod -eq 'PUT') {
        # Only allow writing plain files directly inside data/
        if ([IO.Path]::GetDirectoryName($file) -eq $dataDir -and $path -match '^data/[\w.-]+$') {
          [IO.Directory]::CreateDirectory($dataDir) | Out-Null
          $out = [IO.File]::Create($file)
          $req.InputStream.CopyTo($out)
          $out.Close()
          Write-Host "Saved $path"
          $res.StatusCode = 204
        } else {
          $res.StatusCode = 403
        }
      } elseif ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-cache')
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
      }
    } catch {
      Write-Host "Error: $_"
      $res.StatusCode = 500
    } finally {
      $res.Close()
    }
  }
} finally {
  $listener.Stop()
}
