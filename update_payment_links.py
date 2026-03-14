"""
Firebase Firestore - Payment Link Updater
==========================================
Reads one or more .txt files (each with alternating document-name / URL pairs),
searches ALL collections in Firestore for documents whose ID matches the name
(case-insensitive), and sets/updates the `paymentURL` field.

TXT file format expected:
    Name of Document 1
    https://...

    Name of Document 2
    https://...

Setup:
    pip install firebase-admin

Usage:
    python update_payment_links.py --creds path/to/serviceAccountKey.json --files links1.txt links2.txt
"""

import argparse
import sys
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore


# ──────────────────────────────────────────────
# Parse the txt file into {name_lower: url} dict
# ──────────────────────────────────────────────
def parse_txt_file(filepath: str) -> dict[str, tuple[str, str]]:
    """Returns {lowercased_name: (original_name, url)}"""
    entries: dict[str, tuple[str, str]] = {}
    lines = [l.rstrip() for l in Path(filepath).read_text(encoding="utf-8").splitlines()]

    i = 0
    while i < len(lines):
        # Skip blank lines
        if not lines[i].strip():
            i += 1
            continue

        name_line = lines[i].strip()
        # Next non-blank line is the URL
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1

        if j >= len(lines):
            print(f"  ⚠️  No URL found after name: {name_line!r} — skipping")
            break

        url_line = lines[j].strip()

        if not url_line.lower().startswith("http"):
            print(f"  ⚠️  Expected a URL for '{name_line}' but got: {url_line!r} — skipping block")
            i = j + 1
            continue

        entries[name_line.lower()] = (name_line, url_line)
        i = j + 1

    return entries


# ──────────────────────────────────────────────
# Main update logic
# ──────────────────────────────────────────────
def run(creds_path: str, txt_files: list[str], dry_run: bool):
    # 1. Init Firebase
    cred = credentials.Certificate(creds_path)
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    # 2. Parse all txt files into one lookup map
    lookup: dict[str, tuple[str, str]] = {}
    for f in txt_files:
        print(f"\n📄 Parsing {f}...")
        parsed = parse_txt_file(f)
        print(f"   Found {len(parsed)} entries.")
        lookup.update(parsed)

    if not lookup:
        print("\n❌ No entries found in txt files. Exiting.")
        sys.exit(1)

    print(f"\n🔍 Total unique names to match: {len(lookup)}")

    # 3. Fetch all top-level collections
    collections = list(db.collections())
    print(f"📦 Found {len(collections)} top-level collection(s): {[c.id for c in collections]}\n")

    matched = 0
    skipped = 0
    not_found = set(lookup.keys())

    for col in collections:
        print(f"  🗂  Scanning collection: '{col.id}'")
        docs = col.stream()

        for doc in docs:
            doc_id_lower = doc.id.lower()

            if doc_id_lower.replace("_", " ") in lookup:
                doc_id_lower = doc_id_lower.replace("_", " ")
            if doc_id_lower in lookup:
                original_name, url = lookup[doc_id_lower]
                not_found.discard(doc_id_lower)

                existing = doc.to_dict().get("paymentURL")
                if existing == url:
                    print(f"    ✅ '{doc.id}' — paymentURL already up to date, skipping.")
                    skipped += 1
                    continue

                if dry_run:
                    print(f"    🔸 [DRY RUN] Would update '{doc.id}' → {url}")
                else:
                    doc.reference.update({"paymentURL": url})
                    print(f"    ✏️  Updated '{doc.id}' → {url}")

                matched += 1

    # 4. Summary
    print("\n" + "=" * 50)
    print(f"✅ Matched & updated : {matched}")
    print(f"⏭️  Already up to date: {skipped}")
    print(f"❌ Not found anywhere : {len(not_found)}")
    if not_found:
        print("\nUnmatched names:")
        for name_lower in sorted(not_found):
            original = lookup[name_lower][0]
            print(f"   - {original!r}")
    if dry_run:
        print("\n⚠️  DRY RUN — no changes were written to Firestore.")
    print("=" * 50)


# ──────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Update paymentURL field in Firestore from txt files.")
    parser.add_argument("--creds", required=True, help="Path to Firebase service account JSON file")
    parser.add_argument("--files", required=True, nargs="+", help="One or more .txt files with URL/name pairs")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing to Firestore")
    args = parser.parse_args()

    run(args.creds, args.files, args.dry_run)