# Initial setup
add your service account key.json from firebase to root folder

# Update payment links
create your python env and download dependencies in it 

# Run
for html files just use Go Live in vscode


for python
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
```
python update_payment_links.py --creds path/to/serviceAccountKey.json --files links1.txt links2.txt
```
