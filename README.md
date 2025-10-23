# Obsidian Henni Plugin

Henni watches your vault for new media and keeps companion notes in sync. It can scan existing images, PDFs, and other digital assets, generate note stubs from customizable templates, and automatically organize the output into folders you configure.

## Installation (BRAT)

1. Install the **[Beta Reviewers Auto-update Tester (BRAT)](https://github.com/TfTHacker/obsidian42-brat)** community plugin in Obsidian and enable it.
2. Open BRAT settings → *Add Beta plugin*.
3. Paste this repository URL and confirm: `https://github.com/arminpfarr/obsidian-henni-plugin`
4. BRAT will fetch the latest build and place it in your vault’s plugin folder.
5. Back in Obsidian, enable **Obsidian Henni Plugin** in *Settings → Community plugins*.

Once active, visit the plugin’s settings panel to choose target folders, file extensions, and per-media note templates.

## What the plugin can do

### Automatically generate companion notes
- Monitor new media files (images, PDFs, and custom “other” extensions) and create or update matching notes.
- Use separate target folders per media kind, with optional templating for note content.
- Support suffix- or prefix-based note file names and configurable frontmatter keys for media links.
- Refresh existing notes when rescanned, avoiding duplicates while keeping YAML in sync.

### Work with existing assets on demand
- Commands to scan the entire vault for images, PDFs, or other media and populate missing notes.
- Context menu actions (and matching command palette entries) to create, open, or delete the note for the currently selected file.
- Folder-level actions to generate notes for every supported media file inside the folder and its subfolders (ignoring source whitelists to simplify bulk imports).

### Control which files are eligible
- Configure per-media “source folders” to limit automatic processing to particular directories.
- Manual actions can override the whitelist, so one-off files outside the approved paths can still receive notes when you explicitly trigger creation.

### Work with PDF covers
- Extract the first page of a PDF as an image and store it in a configurable folder for use as a cover or preview.

### Manage referenced sources
- Define which frontmatter key stores the canonical link to the media (defaults to `url`).
- Context menu entry *Open referenced source* resolves wiki-links, vault-relative paths, or external URLs and opens them immediately.
- The same capability is exposed in the command palette via *Open referenced source for current note*.

### Rich settings UI
- Configure media-specific note folders, template locations, and extension lists.
- Toggle automatic note creation for newly-added files.
- Manage image/PDF/other source folder whitelists using a built-in folder picker.
- Adjust frontmatter property names for both the media link and a cover image.

### Miscellaneous conveniences
- Deduplicated template caching with manual clears when template paths change.
- Intelligent note naming to avoid collisions (`(copy N)` suffixes) and to respect custom suffix/prefix preferences.
- EXIF metadata extraction for images, including formatted exposure times and GPS coordinates for templates.
- Customizable PDF cover extraction quality, generating JPG thumbnails alongside notes.
