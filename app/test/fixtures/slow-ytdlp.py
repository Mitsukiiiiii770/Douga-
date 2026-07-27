#!/usr/bin/env python3
import sys, time
args = sys.argv[1:]
if '-J' in args:
    print('{"id":"x","title":"t","formats":[]}'); sys.exit(0)
tmpl = None
for i,a in enumerate(args):
    if a == '--progress-template': tmpl = args[i+1][len('download:'):]
print('[download] Destination: /tmp/x.mp4', flush=True)
for s in range(1, 21):
    print(tmpl.replace('%(progress.status)s','downloading')
             .replace('%(progress.downloaded_bytes)s',str(s*100))
             .replace('%(progress.total_bytes)s','2000')
             .replace('%(progress.total_bytes_estimate)s','NA')
             .replace('%(progress.speed)s','1000')
             .replace('%(progress.eta)s','1')
             .replace('%(progress.fragment_index)s','NA')
             .replace('%(progress.fragment_count)s','NA'), flush=True)
    time.sleep(0.15)
