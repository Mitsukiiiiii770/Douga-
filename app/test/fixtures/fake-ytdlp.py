#!/usr/bin/env python3
"""テスト用の yt-dlp スタブ。-J なら JSON、それ以外は進捗行を吐く。"""
import sys, json, time

args = sys.argv[1:]
url = args[-1]

if '-J' in args:
    if 'playlist' in url:
        print(json.dumps({
            "_type": "playlist", "title": "テストプレイリスト",
            "entries": [
                {"url": "https://example.com/v1", "title": "動画1", "duration": 61},
                {"url": "https://example.com/v2", "title": "動画2", "duration": 125},
            ]}))
    else:
        print(json.dumps({
            "id": "abc123", "title": "テスト動画", "uploader": "テスト投稿者",
            "duration": 212, "thumbnail": "https://example.com/t.jpg",
            "extractor_key": "Generic", "is_live": False,
            "formats": [
                {"format_id": "18", "ext": "mp4", "width": 640, "height": 360,
                 "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "tbr": 700, "filesize": 12345678},
                {"format_id": "137", "ext": "mp4", "width": 1920, "height": 1080, "fps": 60,
                 "vcodec": "avc1.640028", "acodec": "none", "tbr": 4500, "filesize": 98765432},
                {"format_id": "251", "ext": "webm", "vcodec": "none", "acodec": "opus",
                 "abr": 128, "filesize": 3456789},
                {"format_id": "sb0", "ext": "mhtml", "vcodec": "none", "acodec": "none"},
            ]}))
    sys.exit(0)

# 進捗テンプレートを取り出して埋める
tmpl = None
for i, a in enumerate(args):
    if a == '--progress-template' and args[i+1].startswith('download:'):
        tmpl = args[i+1][len('download:'):]

out = None
for i, a in enumerate(args):
    if a == '-o':
        out = args[i+1]

dest = (out or 'out.%(ext)s').replace('%(title).150B', 'テスト動画').replace('%(id)s', 'abc123').replace('%(ext)s', 'mp4')
print(f"[download] Destination: {dest}")
total = 10_000_000
for step in range(1, 6):
    got = total * step // 5
    line = (tmpl
        .replace('%(progress.status)s', 'downloading')
        .replace('%(progress.downloaded_bytes)s', str(got))
        .replace('%(progress.total_bytes)s', str(total))
        .replace('%(progress.total_bytes_estimate)s', 'NA')
        .replace('%(progress.speed)s', '2500000.0')
        .replace('%(progress.eta)s', str(5 - step))
        .replace('%(progress.fragment_index)s', 'NA')
        .replace('%(progress.fragment_count)s', 'NA'))
    print(line, flush=True)
    time.sleep(0.05)
print(f'[Merger] Merging formats into "{dest}"')
