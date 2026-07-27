#!/usr/bin/env python3
"""テスト用スタブ。URL に応じて成功/失敗を作り分け、フォールバックの経路を確かめる。

  ...unsupported... -> Unsupported URL エラー
  ...login...       -> ログインが必要というエラー
  ...drm...         -> 解析は通るが formats が空
  *.m3u8            -> 形式ありで成功
  それ以外          -> 形式ありで成功
"""
import sys
import json

args = sys.argv[1:]
url = args[-1]

FORMATS = [
    {
        "format_id": "hls-1080",
        "ext": "mp4",
        "width": 1920,
        "height": 1080,
        "vcodec": "avc1.640028",
        "acodec": "mp4a.40.2",
        "tbr": 4000,
    }
]

if "unsupported" in url:
    print(f"ERROR: Unsupported URL: {url}", file=sys.stderr)
    sys.exit(1)

if "login" in url:
    print("ERROR: Sign in to confirm your age", file=sys.stderr)
    sys.exit(1)

if "network" in url:
    print("ERROR: Unable to download webpage: getaddrinfo failed", file=sys.stderr)
    sys.exit(1)

if "-J" in args:
    formats = [] if "drm" in url else FORMATS
    print(json.dumps({
        "id": "x1",
        "title": "フォールバック検証",
        "extractor_key": "Generic",
        "formats": formats,
    }))
    sys.exit(0)

print("[download] Destination: /tmp/fallback.mp4")
