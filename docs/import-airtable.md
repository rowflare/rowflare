---
title: Import from Airtable
description: Move Airtable bases to Rowflare with CSV import or direct import using a personal access token. What is copied, what is not, and how field types map.
order: 20
---

There are two ways to bring Airtable data into Rowflare: CSV import, one table at a time, or direct import of a whole base.

## Option A: CSV import

1. In Airtable, open the table and view you want, open the view menu and choose **Download CSV**. Repeat for each table or view.
2. In Rowflare, open a base and choose **Import CSV**.
3. Rowflare creates a new table and infers field types from the values.

CSV carries values only. Links between tables, lookups, rollups, formulas and attachment files are not included; use direct import for those.

## Option B: direct import

### 1. Create a personal access token in Airtable

1. Go to <https://airtable.com/create/tokens> and create a token.
2. Add the scopes `schema.bases:read` and `data.records:read`.
3. Under Access, add the base you want to import.
4. Copy the token (Airtable shows it only once).

### 2. Find the base id

The base id starts with `app` and is visible in the Airtable URL: `https://airtable.com/appXXXXXXXXXXXXXX/tbl...`.

### 3. Run the import

1. In Rowflare, choose **Import from Airtable**.
2. Paste the token and the base id and start the import.

Revoke the token in Airtable when the import is done.

### What is imported

- Tables and fields
- Records
- Linked records
- Lookups and rollups
- Formulas: kept as formulas when Rowflare supports the syntax, otherwise converted to text with their current values
- Attachments: copied into your R2 bucket, because Airtable attachment URLs expire

### What is not imported

Interfaces, automations, extensions, button fields, comments and revision history.

## Field type mapping

| Airtable type | Rowflare type | Notes |
| --- | --- | --- |
| `singleLineText` | Single line text | |
| `email` | Email (text) | |
| `url` | URL (text) | |
| `phoneNumber` | Phone (text) | |
| `multilineText`, `richText` | Long text | |
| `number`, `currency`, `percent`, `rating`, `duration` | Number | |
| `singleSelect` | Single select | |
| `multipleSelects` | Multi select | |
| `date` | Date | |
| `dateTime` | Date (with time) | |
| `checkbox` | Checkbox | |
| `multipleAttachments` | Attachment | Files copied into your R2 bucket |
| `multipleRecordLinks` | Link to records | |
| `lookup`, `multipleLookupValues` | Lookup | |
| `rollup` | Rollup | |
| `formula` | Formula | Unsupported syntax becomes text with current values |
| `createdTime` | Created time | |
| `lastModifiedTime` | Last modified time | |
| `singleCollaborator`, `multipleCollaborators` | User | Matched by email when that person is a workspace member, otherwise text |
| `autoNumber` | Autonumber | |
| `barcode`, `button`, any other type | Single line text | |

## Size limits

Rowflare is designed for 50,000 rows per base and supports up to 125,000 rows per base, which matches Airtable's Team and Business per-base record limits. See [Self-hosting on Cloudflare](self-hosting.md) for performance numbers.
