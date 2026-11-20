"""Put retired conversation logs back exactly where they came from (docs/sessions/AR2-retire.md).

Usage:  python restore.py [--dry-run] [--all-matching] [<session-id or path text>]
  With no argument it restores everything in manifest.jsonl. With one, it restores the entries of that session (its id, any
  case) or whose original path contains the text. A text that matches more than one session needs --all-matching.
  --dry-run hashes every archive copy and prints the counts, changing nothing.
Each file is copied to a fresh hidden name beside its original, given its recorded mtime, flushed and checked against its
manifest SHA-256, then linked into place (never replacing a file that is already there), and only then is the archive copy
removed. The archive copy is found where the manifest says, else at the same relative path beside this script (the archive
folder may have moved, or its drive letter changed); a path that would leave this folder is treated as missing. Exits 1 when
any selected file is missing from the archive, fails its hash, fails to restore, a manifest line cannot be read, or a filter
matches nothing; exits 2 for a usage error. Standalone: needs only Python 3.8 or later.
"""
import hashlib, json, math, os, re, shutil, stat, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOTS = ("claude-projects", "codex-archived-sessions", "codex-sessions")
UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
UUID = re.compile(UUID_TEXT)
ROLLOUT = re.compile("rollout-[0-9t-]{19}-(" + UUID_TEXT + ")")
BS = chr(92)
WINDOWS = os.name == "nt"


def usage():
    print(__doc__)
    sys.exit(2)


args = sys.argv[1:]
dry = "--dry-run" in args
wide = "--all-matching" in args
rest = [a for a in args if a not in ("--dry-run", "--all-matching")]
if len(rest) > 1 or any(a.startswith("-") for a in rest) or (rest and not rest[0].strip()):
    usage()
flt = rest[0].strip() if rest else ""


def lp(p):
    """A path Windows will open past 260 characters (this machine has long paths off): the extended-length form."""
    if not WINDOWS:
        return p
    p = os.path.abspath(p)
    if p.startswith(BS * 2 + "?" + BS):
        return p
    if p.startswith(BS * 2):
        return BS * 2 + "?" + BS + "UNC" + BS + p[2:]
    return BS * 2 + "?" + BS + p


def sha256(p):
    h = hashlib.sha256()
    with open(lp(p), "rb") as f:
        for c in iter(lambda: f.read(4 << 20), b""):
            h.update(c)
    return h.hexdigest()


def session_of(r):
    """The session an entry belongs to: its session field, else (a 2026-10-21 entry) the id in its original path inside the
    client folder, the <id>.jsonl or <id> folder right under .claude/projects/<project>/ or a rollout name's thread id;
    never an id that merely appears in an ancestor folder."""
    s = r.get("session")
    if isinstance(s, str) and s:
        return s.lower()
    src = r["src"].replace(BS, "/").lower()
    mark = "/.claude/projects/"
    if mark in src:
        parts = src.split(mark, 1)[1].split("/")
        if len(parts) > 1:
            name = parts[1][:-len(".jsonl")] if parts[1].endswith(".jsonl") else parts[1]
            if UUID.fullmatch(name):
                return name
    m = ROLLOUT.match(src.rsplit("/", 1)[-1])
    return m.group(1) if m else src


def inside_here(p):
    """Whether p resolves inside this script's folder; both sides in extended-length form, so a deep link cannot hide."""
    here = os.path.realpath(lp(HERE))
    try:
        return os.path.commonpath([here, os.path.realpath(lp(p))]) == here
    except ValueError:  # another drive
        return False


def archive_copy(r):
    """The archive copy: the manifest's path, else the same relative path beside this script, never outside it."""
    if os.path.exists(lp(r["dst"])):
        return r["dst"]
    rel = r.get("rel")
    if not rel:
        parts = r["dst"].replace(BS, "/").split("/")
        hit = [i for i, p in enumerate(parts) if p in ROOTS]
        rel = os.path.join(*parts[hit[0]:]) if hit else None
    if not rel or os.path.isabs(rel):
        return None
    here = os.path.join(HERE, rel)
    return here if inside_here(here) and os.path.exists(lp(here)) else None


def place(tmp, src):
    """Link a finished copy into place; never replace a file that is already there."""
    try:
        os.link(lp(tmp), lp(src))
        return True
    except FileExistsError:
        return False
    except OSError:  # a file system without hard links: check, then rename
        if os.path.exists(lp(src)):
            return False
        os.rename(lp(tmp), lp(src))
        return True


entries, bad = {}, 0
with open(lp(os.path.join(HERE, "manifest.jsonl")), "rb") as f:
    for n, raw in enumerate(f, 1):
        try:
            line = raw.decode("utf-8")
            if n == 1 and line.startswith(chr(0xFEFF)):
                line = line[1:]
            if not line.strip():
                continue
            r = json.loads(line)
            if not all(isinstance(r.get(k), str) for k in ("src", "dst", "sha256")):
                raise ValueError("src, dst and sha256 must be text")
            if any(k in r and not isinstance(r[k], str) for k in ("rel", "session")):
                raise ValueError("rel and session must be text")
            if "mtime" in r and not (isinstance(r["mtime"], (int, float)) and math.isfinite(r["mtime"])):
                raise ValueError("mtime must be a finite number")
        except (UnicodeDecodeError, ValueError, KeyError, TypeError, AttributeError):
            print("unreadable manifest line", n)
            bad += 1
            continue
        entries[r["src"]] = r  # a path retired twice: the newest line wins


def matches(r):
    if not flt:
        return True
    if flt.lower() == session_of(r):
        return True
    return (flt.lower() in r["src"].lower()) if WINDOWS else (flt in r["src"])


selected = [r for r in entries.values() if matches(r)]
if flt and not selected:
    print("no entries match", flt)
    sys.exit(1)
sessions = {session_of(r) for r in selected}
if flt and len(sessions) > 1 and not wide:
    print(f"'{flt}' matches {len(sessions)} sessions; give one session id, or add --all-matching")
    sys.exit(2)

ok = skip = missing = mismatch = failed = left = 0
for r in selected:
    src = r["src"]
    if os.path.exists(lp(src)):
        print("exists, not overwritten:", src)
        skip += 1
        continue
    copy = archive_copy(r)
    if copy is None:
        print("MISSING from the archive:", r["dst"])
        missing += 1
        continue
    if dry:
        try:
            digest = sha256(copy)
        except OSError as e:
            print("cannot read the archive copy:", copy, type(e).__name__)
            failed += 1
            continue
        if digest != r["sha256"]:
            print("hash mismatch:", copy)
            mismatch += 1
        else:
            ok += 1
        continue
    tmp = None
    try:
        os.makedirs(lp(os.path.dirname(src)), exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".restore-", suffix=".partial", dir=lp(os.path.dirname(src)))
        os.close(fd)
        shutil.copyfile(lp(copy), tmp)  # copyfile, not copy2: a read-only attribute must not come along
        mtime = r.get("mtime")
        if isinstance(mtime, (int, float)):
            os.utime(tmp, (mtime, mtime))
        with open(tmp, "rb+") as p:
            os.fsync(p.fileno())
        if sha256(tmp) != r["sha256"]:
            print("hash mismatch, archive copy kept:", copy)
            mismatch += 1
            continue
        if not place(tmp, src):
            print("exists, not overwritten:", src)
            skip += 1
            continue
    except OSError as e:
        print("could not restore, archive copy kept:", src, type(e).__name__)
        failed += 1
        continue
    finally:
        try:
            if tmp and os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            print("left a temporary file:", tmp)
    ok += 1  # restored: the archive copy's removal below is housekeeping, not part of the restore
    try:
        os.chmod(lp(copy), stat.S_IREAD | stat.S_IWRITE)
        os.remove(lp(copy))
    except OSError as e:
        print("restored; archive copy could not be removed:", copy, type(e).__name__)
        left += 1
print(f"{'would restore' if dry else 'restored'} {ok}, skipped {skip}, missing {missing}, mismatched {mismatch}, failed {failed}, unreadable lines {bad}, archive copies left {left}")
sys.exit(1 if (missing or mismatch or failed or bad) else 0)
