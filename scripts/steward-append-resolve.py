#!/usr/bin/env python3
"""Resolve conflicts in APPEND-ONLY steward docs by keeping both sides — but only
after proving each hunk really is an append.

WHY. `docs/steward/CODEBASE-ASSESSMENT.md` and its siblings grow by appending a
dated section per pass. Two branches that each appended conflict at EOF every
single time, and the resolution is always the same: keep both. Doing that by hand
is tedious; doing it with `git checkout --ours/--theirs` is WRONG (it discards one
branch's findings), and doing it with a blind marker-strip is wrong whenever the
two sides actually edited the same prose.

So the value here is the GUARD, not the keep-both. This refuses any hunk where the
two sides share a substantial line, because that is the signature of a real
overlapping edit rather than two independent appends. On refusal it prints the
hunk and changes nothing — a conflict a human should read is left for the human.

    scripts/steward-append-resolve.py --dry-run docs/steward/CODEBASE-ASSESSMENT.md
    scripts/steward-append-resolve.py docs/steward/*.md
"""
import sys

SHARED_LINE_MIN = 40  # a line this long appearing on BOTH sides is not an append


def hunks(lines):
    """Yield (start, mid, end) indices for each conflict hunk, or raise on a malformed one."""
    i = 0
    while i < len(lines):
        if lines[i].startswith('<<<<<<< '):
            mid = end = None
            for j in range(i + 1, len(lines)):
                if lines[j].startswith('=======') and mid is None:
                    mid = j
                elif lines[j].startswith('>>>>>>> '):
                    end = j
                    break
                elif lines[j].startswith('<<<<<<< '):
                    raise SystemExit(f'nested conflict marker at line {j + 1}; resolve by hand')
            if mid is None or end is None:
                raise SystemExit(f'unterminated conflict starting at line {i + 1}; resolve by hand')
            yield i, mid, end
            i = end + 1
        else:
            i += 1


def main(argv):
    dry = '--dry-run' in argv
    unknown = [a for a in argv if a.startswith('--') and a != '--dry-run']
    if unknown:
        # A typo'd flag must never be silently ignored HERE of all places: `--dryrun`
        # was accepted as "not --dry-run" and the file was written. A tool that edits
        # files in place cannot treat an unrecognised safety flag as absent.
        raise SystemExit(f'unknown flag(s): {" ".join(unknown)}\n(did you mean --dry-run?)')
    paths = [a for a in argv if not a.startswith('--')]
    if not paths:
        raise SystemExit(__doc__)
    rc = 0
    for path in paths:
        lines = open(path, encoding='utf-8').read().split('\n')
        spans = list(hunks(lines))
        if not spans:
            print(f'{path}: no conflicts')
            continue
        refused = []
        for start, mid, end in spans:
            ours = [l for l in lines[start + 1:mid] if len(l.strip()) >= SHARED_LINE_MIN]
            theirs = [l for l in lines[mid + 1:end] if len(l.strip()) >= SHARED_LINE_MIN]
            shared = set(ours) & set(theirs)
            if shared:
                refused.append((start + 1, sorted(shared)[0][:80]))
        if refused:
            print(f'{path}: REFUSING — {len(refused)} hunk(s) are not appends (both sides carry the same line):')
            for ln, sample in refused:
                print(f'    line {ln}: {sample}…')
            print('    Nothing written. Read these by hand.')
            rc = 1
            continue
        # Strip ONLY the markers inside the hunks we resolved — never by pattern.
        # A file-wide '=======' strip also eats a Markdown setext H1 underline, which
        # is indistinguishable from a conflict marker by prefix and silently demotes a
        # heading. Address them by INDEX instead.
        markers = set()
        for start, mid, end in spans:
            markers.update((start, mid, end))
        kept = [l for i, l in enumerate(lines) if i not in markers]
        print(f'{path}: {len(spans)} hunk(s) keep-both' + (' (dry-run, not written)' if dry else ''))
        if not dry:
            open(path, 'w', encoding='utf-8').write('\n'.join(kept))
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
