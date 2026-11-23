# 格式说明

> Notes on the blueprint (`CmbAct`) and save formats, in Chinese. The tables should be readable with the offsets alone;
> the code in `tools/lib/cai.js`, `tools/lib/save.js` and `tools/save_inject.js` is the reference.

游戏版本 1.4.3。以下内容都是对着游戏数据和自己的存档实测出来的；标“推测”的部分只有一个样本或没有直接证据。

## 1. 蓝图 `CombinedActorInfo`（魔数 `CmbAct`）

有两种长度，结构相同：
- RomFS 设计图 `Game/BluePrint/CombinedActorInfo/*.cai`：7840 字节（46 个）
- 存档中的究极建造历史：6688 字节，即前一种的前 0x1A20 字节

| 偏移 | 内容 |
|---|---|
| 0x0000 | `"CmbAct\0\0"` |
| 0x0008 | u8 版本 = 2，u8 零件数（≤ 21），u8 粘合数（≤ 21），u8 填充 |
| 0x000C | 21 条零件记录，每条 0x118 字节 |
| 　+0x00 | f32[12] 主刚体位姿，3×4 行主序 [R\|t]，单位米，原点在整体包围盒中心 |
| 　+0x30 | f32[12] 子刚体 1 的位姿（和主刚体在同一个坐标系里，不是相对位姿）；零件没有这个子刚体时为单位阵 |
| 　+0x60 | f32[12] 子刚体 2 的位姿，规则同上 |
| 　+0x90 | f32，含义不明，多为 1.0（`Weapon_Sword_043` 为 1.25） |
| 　+0x94 | u32 0 |
| 　+0x98 | char[128] actor 名；NUL 之后可能残留旧字节 |
| 0x1704 | 21 条粘合记录，每条 12 字节：u32 A 的子刚体序号，u32 B 的子刚体序号，u8 零件 A，u8 零件 B，u16 填充 |
| 0x1800 | f32[6] 包围盒（min xyz, max xyz），u8 标志 = 1 |
| 0x181C–0x1A20 | 不明，所有样本里都是 0 |
| 0x1A20–0x1E84 | 仅 RomFS 版本有：不明，全 0（或 0xCD 填充） |
| 0x1E84 | 仅 RomFS 版本有：第二个包围盒 f32[6]，u8 标志 = 1 |

- 子刚体序号：零件的动态刚体按 ControllerSet 里 `RigidBodyEntityNamePathAry` 的顺序编号，运动学辅助刚体（NavMeshCut、DynamicCutting、
  BeamCutting）不计入。例如大轮胎是 Axis=0、Wheel=1、Steering=2，装在轮胎转动部分上的零件用 1。
- 粘合点的位置不存进文件，游戏建造时自己计算。官方设计图和样本里的粘合都构成一棵树（粘合数 = 零件数 − 1）。
- 游戏存的包围盒大概率来自模型外观，编辑器按碰撞体算出的包围盒与之相差最多约 0.9 m，只影响整体原点。
- 旋转用欧拉角表示时，按游戏的约定 R = Rz·Ry·Rx（先绕 X，再绕 Y，最后绕 Z），即 three.js 的 `'ZYX'`。

## 2. 存档 `progress.sav`（版本 0x0049E946）

- 0x00 u32 `0x01020304`，0x04 u32 版本，0x08 u32 数据区起点。
- 0x20 起是 (u32 哈希, u32 值) 对，分成 33 组，每组以哈希为 0 的一对开头，组的顺序固定：
  Bool、BoolArray、Int、IntArray、Float、FloatArray、Enum、EnumArray、Vector2、Vector2Array、Vector3、Vector3Array、
  String16、String16Array、String32、String32Array、String64、String64Array、Binary、BinaryArray、UInt、UIntArray、
  Int64、Int64Array、UInt64、UInt64Array、WString16、WString16Array、WString32、WString32Array、WString64、WString64Array、
  Bool64bitKey。
- Bool/Int/Float/Enum/UInt 的值直接存在这一对里；其他类型存数据区偏移。数据区按表的顺序紧密排列，文件末尾补零到固定大小
  （2,307,856 字节，按每个数组的最大容量预留）。
- 数组都是 {u32 个数, 元素}；BoolArray 的元素按位存放（每 32 个一个 u32）；Binary 为 {u32 长度, 字节}；
  BinaryArray 为 {u32 个数, 每个元素 {u32 长度, 字节}}。Bool64bitKey 组只有一项，指向数据区末尾的一块 64 位键列表。
- 键名是 murmur3_32（种子 0）哈希，类型和默认值见 `GameData/GameDataList.Product.140.byml.zs`。
- 在 slot_00/02/03/05 上验证过：1783 个偏移项首尾相接，正好铺满数据区。

### 究极建造历史（Struct 1439382339，30 条）

| 文件 | 键 | 类型 | 样本中第 0 条的值 | 含义 |
|---|---|---|---|---|
| progress.sav | 2774999734 | BinaryArray[30] | 6688 字节 `CmbAct` | 蓝图本体 |
| progress.sav | 3531572817 | IntArray[30]（默认 −1） | 0 | 新旧顺序：0 是最新的一条，游戏加新条目时其余条目各 +1 |
| progress.sav | 3317639189 | Vector3Array[30] | (0, 24.56, 51.07) | 推测为预览相机 |
| progress.sav | 4017413287 | Vector3Array[30] | (0, 21.96, 45.68) | 推测为预览相机 |
| progress.sav | 1744090219 | BoolArray[30] | false | 不明 |
| progress.sav | 121274663 | BoolArray[30] | false | 不明 |
| direct_file_save_related.sav | 1079518842 | IntArray[30]（默认 −1） | 0 | 递增编号，最新的一条最大（游戏保存后见到 3,4,5,6） |
| direct_file_save_related.sav | 2982606130 | BoolArray[30] | true | 推测为“已使用” |

另有 Int 1388727046：单调递增的计数（没有历史时为 0，有 1 条后为 1；后来 5 条历史时读到 7，所以不是条数）。

2026-11-22 的观察：存档里有游戏写的 1 条和工具写的 2 条（3531572817 为 0,1,2）。游戏新建 1 条并保存后，
3531572817 变为 1,2,3，新条目为 0；1079518842 变为 3,4,5,6，新条目为 6；1744090219 只有新条目为 true（推测是“新”标记）。
工具写入新条目时照此处理：3531572817 = 0、其余 +1，1388727046 + 1，1079518842 取一个没人用过的编号（见最后一节）。
这样写入的蓝图在游戏里能正常显示和建造。

游戏建造历史里的条目后会把这一条重新保存：零件和粘合不变，但位姿改成它实测的值（有一次所有零件沿 X 移了 5 cm，
操纵杆换了角度，AABB 随之变化）。所以同一个文件再导入时和历史条目不再逐字节相同，工具改用“零件顺序 + 粘合”判断是否相似。

### 究极建造收藏（Struct 2664647268，10 条）

成员为 BinaryArray 3246435831（每条 17304 字节）和 BinaryArray 3153616853（每条 104 字节）。目前所有存档里收藏都是空的，格式待确认。

## 3. 写入存档时的注意事项（`tools/save_inject.js`）

- 新数据插进 BinaryArray 后，后面的数据整体后移，所有指向其后的偏移都要加上增量（包括 Bool64bitKey 那一项）。游戏自己新增记录时也是这样做的。
- 有的游戏目录里 `profile/save-backup/<时间>/` 的自动备份和存档是硬链接。所以写入时要先写临时文件再改名替换，不能原地改写，
  否则备份会被一起改掉。
- 写入前工具会检查：数据区布局仍然首尾相接、新记录能原样读回、除预期的 7 项外其他数据逐项不变；游戏在运行时拒绝写入；
  写入前把这个存档槽的两个文件备份到项目的 `backups/<时间>/`。

## 4. 贴图 TexToGo（`TexToGo/<名称>.txtg`）

材质（BFRES v10 的 FMAT，每个 0xB0 字节）在 +0x20 处有一个贴图名数组（u64 字符串指针），+0xA3 是贴图数量。
名字后缀表示用途：`_Alb` 固有色、`_Nrm` 法线、`_Emm` 自发光、`_Mtl` 金属度、`_Spm` 高光等。

`.txtg` 是一个 "6PK0" 容器：

| 偏移 | 内容 |
|---|---|
| 0x00 | u16 头大小 0x50，u16 版本 0x11，"6PK0" |
| 0x08 | u16 宽，u16 高，u16 深度（数组层数），u8 表面数（mip × 层），u8 2 |
| 0x13 | u8 用途：0 Mtl，1 Alb，3 Emm，6 Spm，0x0A Nrm |
| 0x14 | 通道映射（含义未细究） |
| 0x3C | u8 格式：2 = BC1，5 = BC3，6 = BC4，7 = BC5（逐个解码已知贴图确认） |
| 0x50 | 表面表：每项 4 字节 {u16 层, u8 mip, u8 1}；随后每项 8 字节 {u32 压缩大小, u32 6}；再后面是各表面的 zstd 帧（无字典），依次排列，结尾正好是文件末尾 |

每个表面解压后是 Tegra block-linear 排列的压缩块：GOB 为 64 字节 × 8 行，块高（以 GOB 计）按该级的块行数取不小于它的 2 的幂、最多 16。
反排列之后就是普通的 BCn 数据。实现见 `tools/lib/txtg.js` 和 `tools/lib/bcn.js`（BC1/3/4/5/7 解码和 PNG 写出都是本项目自己写的）。


## 5. 粘合的子刚体

粘合记录里的子刚体序号决定游戏把哪个刚体粘上。游戏设计图里大轮胎（SpObj_SwitchWheel_B_01）的轮胎边缘、轮毂粘合都记为刚体1，
车轴末端记为刚体0；每个大轮胎最多一侧车轴有粘合。实测：一个不倒翁粘在大轮胎边缘却记成了刚体0，游戏就把车轴伸到不倒翁那一侧，
另一侧（本该连着另一个零件的车轴）收进了轮毂，那边的粘合没有成立。其他多刚体零件在设计图里只用刚体0（小轮胎、木车轮、
桩、帆等），弹簧、魔像头用0和1，商队马车用1和2；library.json 的 `bondBodies` 记录了这些。

## 6. 究极建造历史的缩略图缓存

游戏把每条历史的图片存在 `profile/cache/0/icon/Draft_<编号>.png`（PC 版的游戏目录里），编号就是
direct_file_save_related.sav 里 1079518842 的值。这个缓存所有存档槽共用；某个编号已经有图片时游戏直接用它，
没有时才重新画。删掉的历史会留下空号，工具以前用“现有最大编号 + 1”，就可能撞上一个以前属于别的蓝图的编号，
菜单里显示的就是那个旧蓝图的图。现在新条目的编号从计数 1388727046 往上取，跳过任何存档槽在用的编号和已有图片的编号。
