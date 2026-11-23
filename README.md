# totk-blueprint

[中文说明](README.zh-CN.md)

A blueprint editor for Ultrahand builds in *The Legend of Zelda: Tears of the Kingdom*.

Building in the game is great right up until you want something precise: a wheel that's actually centred, two fans
that are actually parallel, a frame that's actually square. This editor lets you lay the parts out on a PC with a mouse
and numbers instead of a controller, snap them together on the same snap points the game uses, and set up the bonds.
It saves the result in the game's own schematic format, and a small tool writes it into the Autobuild history of your
save. Load the save and it's there in the Autobuild menu, ready to build.

No game files are included here. The part library, models and textures are all extracted from your own copy of the
game, on your machine, into a folder that git ignores.

## What you need

- Node.js 22.15 or newer (the tools use the zstd support in `node:zlib`).
- The game's RomFS, dumped from your own copy.
- To write blueprints into a save: the save folder, the one with `slot_00`, `slot_01` and so on.
- Optional, for real 3D models instead of collision shapes: WSL with a build of
  [MeshCodec](https://github.com/dt-12345/MeshCodec).

The import window is a PowerShell script, so that part is Windows only. Everything else is plain Node and a browser.

## Setting up

First tell the tools where the RomFS is. Point `TOTK_ROMFS` at the extracted folder (the one with `Pack/`, `Model/`,
`Mals/` in it):

```powershell
$env:TOTK_ROMFS = "D:\dumps\totk\romfs"
```

A packed `romfs.bin` with an `index.json` next to it works as well. If your game folder sits next to this project and is
called `zelda_king`, you don't need to set anything; `TOTK_INSTALL` points at a game folder somewhere else.

Then build the part library:

```powershell
node tools/scan_assemblable.js
```

```powershell
node tools/build_library.js
```

The first script goes through every actor in the game and keeps the ones Ultrahand can pick up and glue: a dynamic main
body, an object collision layer, a model, and no `AcceptUltraHand: False`. The second turns them into the library the
editor reads, with collision shapes, masses, snap points, joints, and names in English and Chinese. It comes to about
1,400 parts, from Zonai devices and building materials to shrine objects, chests and weapons. Everything lands in
`gamedata/library/`.

Part names come from the game's own text. A few hundred objects are never named in the game; in English they are simply
listed by their actor ID. (The Chinese interface gives most of them a hand-made name, shown in italics.)

### Models (optional)

Without models the editor draws the collision shapes, which works fine but looks rough. The game compresses its meshes
with MeshCodec, so build that once in WSL. It's GPL-2.0 and stays a separate program; this project only runs it:

```powershell
wsl -d Ubuntu-24.04 -- bash -lc "git clone --recursive --depth 1 --shallow-submodules https://github.com/dt-12345/MeshCodec ~/meshcodec && cd ~/meshcodec && cmake -B build . -DCMAKE_BUILD_TYPE=Release -DZSTD_BUILD_SHARED=OFF -DZSTD_BUILD_PROGRAMS=OFF -DZSTD_STATIC_LINKING_ONLY=ON -DBUILD_TESTING=ON && cmake --build build -j8"
```

```powershell
node tools/build_models.js
```

That writes GLB models with base colour, emissive and cut-out textures to `gamedata/library/models/`. It also reads the
rest pose of multi-body parts (wheels, springs, the construct head) from their skeletons, and the big wheel's axle
animations, so the editor shows the axle on the side the game will put it.

## The editor

```powershell
npm --prefix app install
```

```powershell
npm --prefix app run dev
```

Then open http://localhost:5175. The last button on the toolbar switches between English and Chinese.

A quick tour:

- Click a part in the library to add it next to the selected one. Search matches English, Chinese and actor names.
- Move and rotate with the gizmo (W / E), or type positions in metres and angles in degrees in the panel on the right.
  Step sizes for both are in the toolbar.
- **Snap (S):** click a snap point (yellow cone) or any surface on the part you want to move, then one on the part it
  should go to. They meet face to face, and R turns the part 90° around the contact. With "Bond on snap" ticked they
  also get bonded.
- **Bond (B) / Unbond (U):** select a part, press the key, click the other part.
- Parts like the big wheel have several bodies (axle, wheel, steering), and a bond records which body it holds on to.
  The game takes that literally: record the axle when you meant the rim and the axle comes out on the wrong side. The
  editor picks the body that is actually touching, and the checks panel warns about bonds on the wrong body, with a
  button to fix them.
- **Details (I)** labels every bond with its gap and angle. **Guides (G)** shows centres of mass and draws a line
  wherever the selected part lines up with another one.
- Ctrl/Shift+click and Alt+drag select several parts. The panel then has group move and rotate, align to the primary
  part, distribute, and "bond together".
- The checks panel at the bottom right catches the usual mistakes: more than 21 parts, parts that aren't connected,
  bonded parts that are too far apart.
- "Save to folder" writes `<name>.json` (editor format) and `<name>.cai` (game format) to the blueprint folder,
  `blueprint/` in the game folder unless you set `BLUEPRINT_DIR`. You can also open any of the 46 schematics that come
  with the game and start from one of those.

## Putting a blueprint in your save

Close the game first.

On Windows, double-click `import-blueprint.cmd`. A small window lists the `.cai` files in the blueprint folder (or drop
files on it), shows the Autobuild history of the chosen save slot, and imports the one you pick. The window is in
Chinese for now.

Or from the command line:

```powershell
node tools/save_inject.js --list
```

```powershell
node tools/save_inject.js my-car.cai
```

```powershell
node tools/save_inject.js my-car.cai --write
```

Without `--write` it's a dry run that shows what would change. It uses the slot you saved to most recently unless you
pass `--slot 03`. Before writing, both files of the slot are copied to `backups/<time>/`; the new files are written
through a temporary file and a rename, then read back and checked. Next time you load that save, the blueprint is at
the top of the Autobuild history.

The tool looks for saves in `TOTK_SAVE_ROOT`: the folder that holds `slot_00`, `slot_01` and so on, or a folder with
exactly one account folder in it. `--save-dir` does the same for a single command.

About the thumbnails in the Autobuild menu: the game caches one picture per history entry as `Draft_<n>.png` and
reuses it whenever a picture with that number exists. The tool gives new entries a number that no slot uses and no
cached picture has, so the game draws a fresh one. In the game folder this was developed with, that cache is
`profile/cache/0/icon`; set `TOTK_ICON_DIR` if yours is somewhere else.

## Environment variables

| Variable | What it is | Default |
|---|---|---|
| `TOTK_ROMFS` | RomFS, extracted or `romfs.bin` + `index.json` | `romfs/` in `TOTK_INSTALL` |
| `TOTK_INSTALL` | Game folder | `zelda_king` next to this project |
| `TOTK_SAVE_ROOT` | Save folder | `profile/save` in the game folder |
| `TOTK_ICON_DIR` | Autobuild picture cache | `cache/0/icon` next to the save folder |
| `TOTK_BACKUP_ROOT` | Where save backups go | `backups/` |
| `BLUEPRINT_DIR` | The editor's blueprint folder | `blueprint/` in the game folder |
| `MESHCODEC`, `WSL_DISTRO` | MeshCodec's test binary in WSL, and which distro | `~/meshcodec/build/tests/mc_test`, `Ubuntu-24.04` |

## Other tools

| Command | |
|---|---|
| `node tools/dump_actor.js <Actor>` | Dump an actor pack's parameters as JSON to `gamedata/actors/` |
| `node tools/dump_pack.js <path> <out> [filter]` | Dump a shared pack or a single BYML file |
| `node tools/flat.js <json> [regex]` | Flatten JSON into `key=value` lines |
| `npm --prefix app test` | Tests: all 46 game schematics round-trip, snapping, Euler order, bond bodies |

## How it works

[docs/formats.md](docs/formats.md) describes the schematic format (`CmbAct`) and the Autobuild history in
`progress.sav`. It's in Chinese, but the offset tables are most of it. The short version: a blueprint holds up to 21
parts, each with an actor name and a 3×4 pose for each of its bodies, and up to 21 bonds, each naming two parts and
which body of each is glued. Bond positions aren't stored at all; the game works them out when it builds.

All the file formats involved (SARC, BYML, MSBT, BFRES, TexToGo textures, the save file) are read with plain JavaScript
in `tools/lib/`. MeshCodec is the only outside program.

## Things to keep in mind

- This edits your save. It backs up first and checks what it wrote, but keep your own backups too.
- Developed against game version 1.4.x. Blueprints written this way show up and build in game; not every part
  in the library has been tried in a build.
- A few things are still educated guesses, such as what some save fields mean and whether the game accepts bonds that
  form a loop. docs/formats.md marks them.

## License

GPL-3.0. See [LICENSE](LICENSE).

This is a fan project with no connection to Nintendo. Please don't publish files extracted from the game.
