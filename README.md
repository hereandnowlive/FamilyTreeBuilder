# Family Tree Builder

A desktop app for building a family tree together: people and how they are related, the story of each life, the major events in it, and the photos and voice recordings that go with them.

Everything stays on your own computer. There is no account and no website. The tree is shared by passing one file from one family member to the next.

This guide is also built into the app. Press **Help** on the tree screen to read it there.

<!--
  Everything between the guide:start and guide:end markers is shown in the app's Help page
  (src/help/HelpPage.tsx). Each "##" heading becomes one section there.
  Keep it to headings, paragraphs, lists, bold and code. Do not use links, images or tables:
  a link would navigate the app's window away, and the other two are not styled.
-->
<!-- guide:start -->

## How the app works

Family Tree Builder has three screens:

- **The tree** shows everyone and how they are related. This is where you add people.
- **A person's page** holds their details, their story, and the major events of their life with photos.
- **A photo's page** shows one photo at full size, with a description and any voice recordings about it.

Everything you type is saved automatically as soon as you click or tab out of the box. There is no Save button for your edits.

The one thing you do save by hand is the **family file**: a single file holding the whole tree, which you send to the next person. See "Sharing the tree with your family" below.

If two people have each added to their own copy, the two can be combined. See "Merging two copies of the tree".

## Getting started

### If someone sent you a family file

1. Install Family Tree Builder using the installer you were given. Windows may warn that the app is from an unknown publisher. Choose **More info**, then **Run anyway**.
2. Save the family file you were sent somewhere you can find it, such as your Desktop. Its name ends in `.familytree`.
3. Open Family Tree Builder and press **Open a family file you were sent**, or **Open file…** at the top right.
4. Choose the file. The app restarts and shows the tree.

### If you are starting a new tree

1. Open Family Tree Builder and press **Add the first person**.
2. Fill in what you know and press **Add**. Nothing is required, and all of it can be changed later.
3. Grow the tree from that person. See the next section.

## The tree

### Moving around

- **Drag** an empty part of the screen to move the tree.
- **Scroll** to zoom in and out. The buttons at the bottom left do the same, and the bottom one fits the whole tree on screen.
- The small map at the bottom right shows where you are. You can drag inside it.
- Type a name in **Find a person…** and press Enter, or click a result, to jump to someone.

### Adding relatives

Click a person to select them. A row of buttons appears above their card:

- **+ Parent** adds a mother or father. A person can have at most two parents.
- **+ Partner** adds a husband, wife or partner.
- **+ Sibling** adds a brother or sister. This needs the person to have at least one parent in the tree first, because siblings are people who share parents.
- **+ Child** adds a son or daughter. If the person has a partner, you can choose them as the **Other parent**.
- **Open** goes to that person's page. Double-clicking their card does the same.

If the relative is already somewhere in the tree, choose **Already in the tree** in the box that appears, and pick them from the list. This is how you connect two branches without creating someone twice.

**+ New person** at the top adds someone who is not connected to anybody yet. You can link them later.

### How the tree is drawn

You do not position anyone by hand. The app lays the tree out itself every time something changes: one row per generation, with partners side by side and their children below them. The coloured edge of a card shows whether the person is recorded as female or male.

## A person's page

Open a person from the tree to see their page. **← Tree** at the top left takes you back.

- **Details** holds names, sex, and when and where they were born and died. Dates are free text, so you can write whatever you know: `12 Mar 1902`, `Mar 1902`, `abt. 1850`.
- **Family** lists their parents, partners, siblings and children. Click a name to go to that person. The **×** beside a name removes the link between the two people. Both people stay in the tree.
- **Their story** is for writing about their life at any length. Click its title to open it; closed, it shows how the story begins. It stays open or closed as you left it while you move between people.
- **Major events** is described in the next section.
- **Documents** holds files that belong with the person, such as PDFs and Word documents. See "Documents" below.

When you have scrolled a long way down, a **↑ Back to top** button appears at the bottom right.

**Delete person** at the top right removes the person, their links to relatives, and the events and photos that belonged only to them. It asks first, and it cannot be undone.

## Major events and photos

Major events are the moments that shaped a life: a wedding, a move to another country, military service, a new job. Every photo in the app belongs to an event.

### Adding an event

1. On a person's page, press **+ Add event**.
2. Type what happened and, if you know, when. Dates are free text here too.
3. Write as much as you like about it in the box underneath.

Events are shown in order of the year in their date. Events with no year come last.

Each event is a row showing its title, date, and how many photos and people it has. Click a row to open it and see or change everything in it; click the arrow beside its title to close it again. **Expand all** and **Collapse all** at the top of the list open or close every event at once. The app remembers which events you had open until you close it.

### Adding photos

Press **+ Add photos** inside an event and choose one or more pictures. The app copies them, so the originals can be moved or deleted afterwards without affecting the tree.

Under each photo you can:

- Type a short **caption**.
- Press **☆ Use as portrait** to make it the person's picture on the tree and at the top of their page. Press it again to undo.
- Press **Delete** to remove the photo.

The first photo you ever add for a person becomes their portrait automatically.

Supported pictures: JPG, PNG, GIF, WebP, BMP and AVIF.

### Sharing an event between people

Many events belong to more than one person. A wedding belongs to both partners, and a family holiday to everyone who went.

- In the event, choose a name from **+ Share with a person…**. The event now appears on their page as well.
- It is one event, not a copy. Its text, photos and recordings are the same on every page, and a change made on one page shows on all of them.
- Each person can still choose their own portrait from the photos.
- The **×** beside a name takes the event off that person's page.
- **Remove from this page** takes it off the page you are on and keeps it for the others.

### Deleting an event

**Delete event** removes the event and its photos. For a shared event the button reads **Delete for everyone**, and it removes the event from every page it is on. Both ask first and cannot be undone.

## A photo's page

Click any photo to open its own page.

- The photo is shown at full size.
- **Caption** is the short title shown under the photo elsewhere.
- **Description** is for everything else: who is in it, where and when it was taken, the story behind it.
- **☆ Use as portrait** and **Delete photo** are at the top right.
- **⟲ Rotate left** and **⟳ Rotate right** turn a photo that is sideways or upside down by a quarter turn, and save it that way everywhere it is shown. Use the button for the direction you want instead of going all the way round: a JPEG photo loses a very small amount of detail each time it is saved again. Animated GIF and AVIF pictures cannot be rotated in the app.
- **Save a copy…** saves the photo as an ordinary picture file, starting on your Desktop, so you can print it, email it or use it elsewhere. The copy in the app stays where it is.

The button at the top left, showing the person's name, takes you back to the same place on their page.

## Voice recordings

Each photo can have recordings attached: someone telling the story behind it, or an old interview. They are listed on the photo's page under **Recordings**, each with its own player: press the round button to play or pause, and click or drag along the bar to move to another part. The time is shown beside it; for a recording made in the app, its full length may only appear once it has been played through.

### Recording in the app

1. On the photo's page, press **● Record** and start talking.
2. Watch the green bar. It should move as you speak. If it stays still, the app is not hearing you. See "If something goes wrong" below.
3. Press **Stop and save** to keep the recording, or **Discard** to throw it away. A saved recording appears at the bottom of the list with a note saying it is saved.

If you leave the page while recording, the recording is saved rather than lost.

### Adding a recording you already have

Press **+ Add audio** and choose the file. Supported files: MP3, M4A, AAC, WAV, OGG, Opus and FLAC.

### After adding

Type in the box above a recording to name it. **Save a copy…** saves it as an ordinary audio file, starting on your Desktop. **Remove** deletes it.

## Documents

A person's page has a **Documents** list at the bottom for files that belong with them: a birth certificate saved as a PDF, a letter typed up in Word, a spreadsheet of census entries.

1. Press **+ Add documents** and choose one or more files. The app copies them, so the originals can be moved or deleted afterwards.
2. Each document starts with the name of its file. Type in the box to give it a better one.

- **Open** shows the document in the program your computer normally uses for it, such as your PDF viewer or Word. Changes you make there are not something to rely on: to replace a document, remove it and add the new version.
- **Save a copy…** saves it as an ordinary file, starting on your Desktop.
- **Remove** deletes the copy stored in the app. It asks first.

These kinds of file can be added: PDF, Word (`.doc`, `.docx`), Excel (`.xls`, `.xlsx`), PowerPoint (`.ppt`, `.pptx`), OpenDocument (`.odt`, `.ods`, `.odp`), rich text (`.rtf`), plain text (`.txt`) and `.csv`. Photos belong in an event instead, where they can be seen.

Documents travel inside the family file with everything else.

## Sharing the tree with your family

The whole tree, with every photo and recording, travels as one **family file**. Its name ends in `.familytree`.

### The simplest way to work

Treat the file like a baton. Whoever has it makes their changes, saves the file, and passes it on. Everyone else waits. Done this way, there is never anything to sort out.

**Open file…** replaces your tree with the one in the file. If you have made changes of your own that are not in that file, do not use it. Use **Merge file…** instead, described in the next section.

### Sending the tree to someone

1. On the tree screen, press **Save file…**.
2. Choose where to save it. The Desktop is easy to find.
3. Send that file to the next person. Family files with many photos are large, often too large for email. Use a USB stick or a file-sharing service.

### Opening a file you were sent

1. On the tree screen, press **Open file…** and choose the file.
2. The app warns you that the tree in the app will be replaced by the one in the file. Press **Replace my tree** to continue.
3. The app restarts and shows the tree from the file.

Before replacing anything, the app keeps a backup of the tree you had. See the next section.

## Merging two copies of the tree

Use this when two people have each made changes to their own copy. Merging combines the file you were sent with the tree in your app, keeping both people's work.

### How to merge

1. On the tree screen, press **Merge file…** and choose the family file you were sent.
2. The merge screen appears. Nothing has changed yet.
3. Read **What the file adds**: the people, events, photos, recordings, documents and family links that are in the file but not in your tree.
4. If there is a **Differences to settle** list, choose **Keep mine** or **Use the file's** for each one. See below.
5. Press **Merge into my tree**. To back out instead, press **Cancel merge** and nothing changes.

Afterwards, press **Save file…** and send the merged tree back, so that everyone ends up with the same thing.

### What happens without you having to decide

- Anything that is only in the file is added to your tree.
- Anything that is only in your tree stays.
- Where one copy has a blank and the other has something written, the written one is used. If you filled in a birth date and they filled in a birthplace for the same person, you get both.

### Differences to settle

A difference is where both copies have something written for the same thing and they do not match: two different birth dates for one person, say, or two versions of a life story. The app shows both side by side and you choose one for each. You cannot merge until every one is chosen.

**Keep mine for all** and **Use the file's for all** choose everything at once.

Whichever you do not choose is not thrown away. See "Getting back something that was overridden" below.

### Things merging cannot do

- **It never deletes.** If one of you deleted a person or a photo and the other did not, it will be in the merged tree. Delete it again afterwards.
- **It cannot tell that two people are the same.** If you each added Great-uncle Harold separately, he will be in the tree twice. The merge screen warns you when a name being added is already in your tree. Afterwards, keep the fuller one, add anything missing to it, and delete the other.
- **A person has at most two parents.** If combining both copies would give someone three, the app asks you to choose one copy's parents for that person.

### Getting back something that was overridden

When you settle differences, the app keeps a complete copy of each tree that lost out, in a folder called `overrides` (see "Where your information is kept"). Each merge gets its own folder there, named with the date and time, holding one or both of:

- `my tree before the merge.familytree`, kept if you chose **Use the file's** for anything.
- `the file that was merged in.familytree`, kept if you chose **Keep mine** for anything.

These are never deleted automatically. To look something up, save your current tree first with **Save file…**, open the overrides copy with **Open file…**, find what you need and copy it down, then open your saved tree again and type it in.

## Where your information is kept

Your tree is stored in the app's own folder on your computer, not inside the app itself. Reinstalling or updating the app does not touch it.

- **Windows:** `%APPDATA%\com.mitchell.familytree`. Paste that into the address bar of File Explorer to go there.
- **Linux:** the tree is in `~/.config/com.mitchell.familytree`, and photos, recordings, documents, backups and overrides are in `~/.local/share/com.mitchell.familytree`.

### Backups

- **Make your own.** Press **Save file…** now and then and keep the file somewhere safe, such as another drive. That file is a complete copy of everything.
- **Automatic ones.** Each time you open or merge a family file, the app first saves the tree you had into a `backups` folder in the location above. It keeps the three most recent. They are ordinary family files, so you can get an old tree back with **Open file…**.
- **Overrides.** Copies kept when you settle differences in a merge go into an `overrides` folder in the same location. These are kept until you delete them yourself.

## If something goes wrong

**The green bar does not move when I record.** The app uses the microphone your computer has chosen as its default. Open your computer's sound settings, check that the right microphone is selected as the input device and is not muted, then try again.

**"No microphone was found."** Plug in a microphone or headset, or switch on the built-in one in your sound settings.

**A document will not open.** The app hands it to the program your computer uses for that kind of file, so the computer needs one: a PDF viewer for PDFs, Word or LibreOffice for Word files. Use **Save a copy…** to get the file out and open it another way.

**"This recording could not be played on this computer."** The computer cannot play that kind of audio file. MP3 files and recordings made in the app play everywhere.

**"This is not a Family Tree Builder file."** The file you chose is not a family file, or it was damaged on the way to you. Ask for it to be sent again. Your tree has not been changed.

**"This file was saved by a newer version of Family Tree Builder."** The person who sent the file has a newer version of the app than you. Install the newer version, then open the file again. Your tree has not been changed.

**I opened the wrong file and my tree is gone.** It is not gone. Press **Open file…**, go to the `backups` folder described above, and open the most recent file there.

**Someone is in the tree twice after a merge.** Each of you added the same person separately. Keep the one with more filled in, add anything missing to it, and delete the other.

**A merge went wrong and I want my old tree back.** Press **Open file…**, go to the `backups` folder described above, and open the file whose name starts with `before-merge`.

**A person will not let me add a sibling.** Add at least one of their parents first.

**Photos take a moment to appear.** The first time a photo is shown, the app makes a small preview of it. After that it appears straight away.

<!-- guide:end -->

## For developers

This part is not shown in the app.

### What it is built with

- **Tauri 2** (Rust) for the desktop shell, file handling, thumbnails and microphone recording
- **React 19** and **TypeScript** with **Vite** for the interface
- **Tailwind CSS 4** for styling
- **SQLite** through `rusqlite`, with SQLite itself compiled into the app and the queries written in Rust
- **React Flow** (`@xyflow/react`) and **dagre** for drawing and laying out the tree

### What you need

- Node.js and npm
- Rust, installed with `rustup`. The exact version is pinned in `rust-toolchain.toml`, and rustup downloads it on the first build
- On Linux, the Tauri system packages plus the ones for audio and the MP3 encoder:
  `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev build-essential libasound2-dev autoconf`
- On Windows, the "Desktop development with C++" tools from Visual Studio Build Tools

### Commands

Run these from the project folder.

| Command | What it does |
| --- | --- |
| `npm install` | Installs the JavaScript dependencies. Run once after getting the code. |
| `npm run app` | Runs the app for development, with live reload. |
| `npm run build` | Type-checks and bundles the interface. A quick check after TypeScript changes. |
| `npm run typecheck` | Type-checks only. |
| `npm test` | Runs the merge planner tests in `tests/`, one at a time, with Node's built-in test runner. |
| `cargo test` (in `src-tauri`) | Runs the Rust tests: the database, migrations, merging and family files. |
| `npm run app:build` | Builds the optimised app and its installers, and copies them to `installer/`. Takes several minutes. |
| `npm run clean` | Deletes the Rust build output in `src-tauri/target`. Safe; the next build takes minutes. |

Tauri builds for the system it runs on, so the Windows installer has to be built on Windows. `.github/workflows/release.yml` does that on GitHub's machines: once this project is in a GitHub repository, start the "Release" workflow by hand and it builds the Linux and Windows installers and publishes them as a release named after the version in `src-tauri/tauri.conf.json`.

### Where things are

| Path | Contents |
| --- | --- |
| `src/` | The interface. `db.ts` holds every call into Rust. |
| `src/tree/` | The tree screen and its automatic layout. |
| `src/person/` | The person page, events, the photo page and the recorder controls. |
| `src/merge/` | Merging a family file: `plan.ts` works out what would change, `MergePage.tsx` is the review screen. |
| `src/help/` | The Help page, which displays the guide section of this file. |
| `src-tauri/src/` | The Rust side: `lib.rs` (commands), `db.rs` (the database and every query), `merge.rs` (applying a merge), `family_file.rs`, `thumbnail.rs`, `rotate.rs`, `recorder.rs`. |
| `tests/` | Tests for the merge planner. |
| `src-tauri/migrations/` | The database schema, as numbered SQL files. |
| `scripts/copy-installer.mjs` | Gathers the built installers into `installer/` at the end of `npm run app:build`. |

### Things to know before changing it

- **Never edit a migration that has been applied.** Add a new numbered file and append it to `MIGRATIONS` in `db.rs`. The database only remembers how many migrations it has had, so an edit to an old one never reaches existing trees. Under `npm run tauri dev`, a new migration is applied to your real data the moment the file is saved, so test the SQL on a copy first.
- **The database lives outside the project.** Development uses the same folders listed under "Where your information is kept", so the tree you see while developing is real data.
- **Do not remove `src-tauri/.cargo/config.toml`.** It caps Cargo at 8 parallel compilers, because the default of one per core ran a 32-core, 30 GB machine out of memory during a release build. It also moves Cargo's build files to a path without spaces, which the MP3 encoder's build needs on Linux when the project folder has spaces in its path.
- **The release build has no link-time optimisation**, for the same memory reason. See the comment above `[profile.release]` in `src-tauri/Cargo.toml` before adding it back.
- **The content security policy only applies to a built app.** It is set in `src-tauri/tauri.conf.json` and limits what the window may load to the app's own files and stored photos and recordings. `npm run app` does not enforce it, so try anything that loads from a new kind of source in an installed build.
- **The Help page is this file.** Edit the guide above and the app's Help page changes with the next build.
