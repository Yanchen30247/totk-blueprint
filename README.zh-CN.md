# totk-blueprint

[English](README.md)

《塞尔达传说 王国之泪》究极手载具的蓝图编辑器。

在游戏里搭东西很好玩，但想做得精确就很难：轮子要正好居中，两个风扇要真的平行，车架要方方正正。这个编辑器让你在电脑上
用鼠标和数字摆零件，用和游戏一样的吸附点把零件对上，设置好粘合，然后存成游戏自己的设计图格式。再用一个小工具把它写进
存档的究极建造历史里，进游戏读档，在究极建造菜单里就能直接造出来。

仓库里没有任何游戏文件。零件库、模型和贴图都是在你自己的电脑上，从你自己的游戏里提取出来的，放在 git 忽略的目录里。

## 需要什么

- Node.js 22.15 或更新（工具用到了 `node:zlib` 的 zstd）。
- 从你自己的游戏里导出的 RomFS。
- 要写进存档的话：存档文件夹，也就是里面有 `slot_00`、`slot_01` 这些的那个。
- 可选：想看真实模型而不是碰撞体，需要在 WSL 里编译 [MeshCodec](https://github.com/dt-12345/MeshCodec)。

导入窗口是 PowerShell 写的，只能在 Windows 上用；其他部分只要 Node 和浏览器。

## 准备

先告诉工具 RomFS 在哪。把 `TOTK_ROMFS` 设成解包后的文件夹（里面有 `Pack/`、`Model/`、`Mals/` 的那一层）：

```powershell
$env:TOTK_ROMFS = "D:\dumps\totk\romfs"
```

打包成 `romfs.bin` 加 `index.json` 的形式也能读。如果游戏目录就在本项目旁边、叫 `zelda_king`，什么都不用设；
游戏目录在别处的话用 `TOTK_INSTALL` 指过去。

然后生成零件库：

```powershell
node tools/scan_assemblable.js
```

```powershell
node tools/build_library.js
```

第一个脚本把游戏里所有 actor 过一遍，留下究极手能抓起来粘的：主刚体是动态的、碰撞层是物体类、有模型、没有标
`AcceptUltraHand: False`。第二个把它们做成编辑器用的零件库，包括碰撞体、质量、吸附点、关节和中英文名字。
一共大约 1400 个零件，从左纳乌装置、建材到神庙机关、宝箱和武器都有，全部写到 `gamedata/library/`。

零件名优先用游戏自己的文本。有些东西游戏里压根没起名字，中文这边有几百个是照着 actor 名手动起的，
英文就直接用 actor 名拆成单词。这类名字在编辑器里显示为斜体。

### 模型（可选）

没有模型时编辑器画的是碰撞体，能用，就是不好看。游戏的网格数据是用 MeshCodec 压缩的，需要先在 WSL 里编译一次。
它是 GPL-2.0 的独立程序，本项目只是调用它：

```powershell
wsl -d Ubuntu-24.04 -- bash -lc "git clone --recursive --depth 1 --shallow-submodules https://github.com/dt-12345/MeshCodec ~/meshcodec && cd ~/meshcodec && cmake -B build . -DCMAKE_BUILD_TYPE=Release -DZSTD_BUILD_SHARED=OFF -DZSTD_BUILD_PROGRAMS=OFF -DZSTD_STATIC_LINKING_ONLY=ON -DBUILD_TESTING=ON && cmake --build build -j8"
```

```powershell
node tools/build_models.js
```

它会把带固有色、自发光和镂空贴图的 GLB 模型写到 `gamedata/library/models/`。还会从骨架里读出多刚体零件（轮胎、弹簧、
魔像头）各部分的静止位置，以及大轮胎的车轴动画，编辑器就能把车轴画在游戏实际会伸出的那一侧。

## 编辑器

```powershell
npm --prefix app install
```

```powershell
npm --prefix app run dev
```

然后打开 http://localhost:5175 。工具栏最后一个按钮切换中文和英文界面。

大概怎么用：

- 在零件库里点一下就加进来，放在选中零件旁边。搜索支持中文名、英文名和 actor 名。
- 拖坐标轴移动、旋转（W / E），或者在右侧直接输入位置（米）和角度（度）。步进在工具栏里设。
- **吸附（S）**：先点要移动的零件上的吸附点（黄色锥）或任意表面，再点目标零件上的。两个面会贴在一起，R 绕接触面转 90°。
  勾上"吸附时粘合"会顺手粘上。
- **粘合（B）/ 取消粘合（U）**：选中一个零件，按键，再点另一个零件。
- 大轮胎这类零件有好几个刚体（车轴、轮胎、转向），粘合会记下粘的是哪一个，游戏完全照着来：本来粘在轮胎边缘却记成了车轴，
  游戏就会把车轴伸到错的那一侧。编辑器会按实际接触的刚体记录，检查栏发现记错了会提示，点一下"按接触修正"就好。
- **详细信息（I）** 给每条粘合标上间隙和夹角；**对齐辅助（G）** 显示质心，选中零件和别的零件对齐时会连线标出来。
- Ctrl/Shift+点击、Alt+拖动可以多选，右侧面板里有整体平移旋转、对齐到主零件、等距分布、"粘成整体"。
- 右下角的检查栏会提示常见问题：超过 21 个零件、零件没连成一体、粘合的两个零件离得太远等。
- "保存到文件夹"会在蓝图文件夹里写 `<名称>.json`（编辑器格式）和 `<名称>.cai`（游戏格式），蓝图文件夹默认是游戏目录下的
  `blueprint/`，可以用 `BLUEPRINT_DIR` 改。游戏自带的 46 张设计图也能直接打开，在它们的基础上改。

## 写进存档

先退出游戏。

Windows 上双击 `import-blueprint.cmd` 会打开一个小窗口：左边列出蓝图文件夹里的 `.cai`（也可以把文件拖进去），
右边显示所选存档槽的究极建造历史，选好点"导入到存档"就行。

也可以用命令行：

```powershell
node tools/save_inject.js --list
```

```powershell
node tools/save_inject.js my-car.cai
```

```powershell
node tools/save_inject.js my-car.cai --write
```

不加 `--write` 只是试运行，告诉你会改什么。默认用最近保存的存档槽，`--slot 03` 可以指定。写入前会把这个槽的两个文件
备份到 `backups/<时间>/`，写的时候先写临时文件再改名替换，写完再读回来检查一遍。之后读这个存档，蓝图就在究极建造
历史的最前面。

存档位置由 `TOTK_SAVE_ROOT` 决定：直接指向含有 `slot_00`、`slot_01` 的文件夹，或者指向里面只有一个账号文件夹的上一层。
单次命令也可以用 `--save-dir`。

关于菜单里的缩略图：游戏给每条历史缓存一张 `Draft_<编号>.png`，只要这个编号的图存在就直接拿来用。所以工具给新条目的编号
既不和任何存档槽冲突，也没有对应的缓存图片，游戏会重新画一张。开发时用的游戏目录里，这个缓存在 `profile/cache/0/icon`；
你的不在那里的话设 `TOTK_ICON_DIR`。

## 环境变量

| 变量 | 是什么 | 默认 |
|---|---|---|
| `TOTK_ROMFS` | RomFS，解包的文件夹或 `romfs.bin` + `index.json` | `TOTK_INSTALL` 里的 `romfs/` |
| `TOTK_INSTALL` | 游戏目录 | 本项目旁边的 `zelda_king` |
| `TOTK_SAVE_ROOT` | 存档文件夹 | 游戏目录的 `profile/save` |
| `TOTK_ICON_DIR` | 究极建造缩略图缓存 | 存档文件夹旁边的 `cache/0/icon` |
| `TOTK_BACKUP_ROOT` | 存档备份放哪 | `backups/` |
| `BLUEPRINT_DIR` | 编辑器的蓝图文件夹 | 游戏目录的 `blueprint/` |
| `MESHCODEC`、`WSL_DISTRO` | WSL 里 MeshCodec 测试程序的路径、用哪个发行版 | `~/meshcodec/build/tests/mc_test`、`Ubuntu-24.04` |

## 其他工具

| 命令 | |
|---|---|
| `node tools/dump_actor.js <Actor>` | 把 actor 包里的参数导出成 JSON（`gamedata/actors/`） |
| `node tools/dump_pack.js <路径> <输出> [过滤]` | 导出公共包或单个 BYML 文件 |
| `node tools/flat.js <json> [正则]` | 把 JSON 展平成 `键=值` |
| `npm --prefix app test` | 测试：46 张官方设计图往返、吸附、欧拉角约定、粘合刚体 |

## 原理

[docs/formats.md](docs/formats.md) 写了设计图格式（`CmbAct`）和 `progress.sav` 里的究极建造历史。简单说：一张蓝图最多
21 个零件，每个零件记 actor 名和每个刚体的 3×4 位姿；最多 21 条粘合，每条记两个零件和各自粘的是哪个刚体。
粘合点的位置根本不存，游戏建造时自己算。

涉及的文件格式（SARC、BYML、MSBT、BFRES、TexToGo 贴图、存档）都是在 `tools/lib/` 里用纯 JavaScript 读的，
外部程序只有 MeshCodec。

## 注意

- 这个工具会改你的存档。它会先备份、写完会检查，但你自己也最好留一份备份。
- 基于游戏 1.4.x 版本的数据开发。这样写进去的蓝图在游戏里能正常显示和建造；但零件库里的零件没有每个都实际造过。
- 有些地方还是推测，比如部分存档字段的含义、粘合成环游戏认不认。docs/formats.md 里都标出来了。

## 许可证

GPL-3.0，见 [LICENSE](LICENSE)。

这是玩家自己做的项目，和任天堂没有关系。请不要公开发布从游戏里提取出来的文件。
