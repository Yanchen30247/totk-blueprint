// Display names for library parts, from the game's own text where it has one. Chinese (CNzh) and English (USen).
// Order: the actor's name entry in any message file of the language (ActorMsg first) -> the same for the actor it is a
// variant of (name with trailing parts cut off) -> the fuse "common name" in its AttachmentParam
// (StaticMsg/AttachmentCommonName, e.g. 格板 / Lattice) -> in Chinese only: enemy figurines from the enemy's name and
// descriptive names made from the actor name (marked "guess"). English keeps to the game's text; a part without one is
// shown by its actor name.
'use strict';
const { parseSarc } = require('./sarc');
const { parseMsbt } = require('./msbt');

const FIRST = ['ActorMsg/Attachment.msbt', 'ActorMsg/PouchContent.msbt', 'ActorMsg/PictureBook.msbt'];

/** Building materials: 木长板（大） etc. from the actor name. */
function materialName(actor) {
  const mat = [['WhiteWood', '白木'], ['StoneLight', '轻石'], ['Wood', '木'], ['Metal', '铁'], ['Stone', '石'], ['Rock', '岩']];
  const shape = [['Rectangle', '长板'], ['Square', '方板'], ['Stick', '棍'], ['Pole', '杆'], ['Parts', '块']];
  const size = [['_LL_', '（大）'], ['_L_', '（大）'], ['_M_', '（中）'], ['_S_', '（小）']];
  const m = mat.find(([k]) => actor.includes(k));
  const s = shape.find(([k]) => actor.includes(k));
  if (!m || !s || !/^(AsbObj|SkyObj)_/.test(actor)) return null;
  const z = size.find(([k]) => actor.includes(k));
  return m[1] + s[1] + (z ? z[1] : '');
}

const side = (s) => ({ L: '左', R: '右' }[s] || s);
const num = (s) => (s ? ' ' + s.replace(/^0(?=\d\d)/, '') : '');

// Descriptive names for parts the game has no text for. Each rule: [pattern, name or (match) => name].
const RULES = [
  [/^HiddenKorok_SilhouettePazzle_(\d+)$/, (m) => '克洛格剪影拼图' + num(m[1])],
  [/^AsbObj_Assassin_Chassis(\d)w_/, (m) => `依盖队${'零一二三四'[+m[1]]}轮底盘`],
  [/^AsbObj_Assassin_KohgaChassis1_(\d)$/, (m) => `可盖的底盘（${m[1]}）`],
  [/^AsbObj_Assassin_KohgaGuard_/, '可盖的护板'],
  [/^AsbObj_Assassin_SpikeChassis4w_/, '依盖队尖刺四轮底盘'],
  [/^AsbObj_Assassin_TankKeyChassis4w_/, '依盖队战车底盘'],
  [/^AsbObj_BalloonEnvelopeCandle_/, '热气球的蜡烛'],
  [/^AsbObj_CaravanWagon_A_(\d+)$/, (m) => '商队马车部件' + num(m[1])],
  [/^AsbObj_WagonSteeringCollectObject_/, '马车转向部件'],
  [/^AsbObj_WoodIchikaraRopeway_/, '一始村的缆车吊篮'],
  [/^AsbObj_WoodRaftChair_/, '木筏座椅'],
  [/^AsbObj_WoodSail_/, '帆'],
  [/^AsbObj_WoodWagonSeat_/, '马车座椅'],
  [/^AsbObj_WoodWheel_/, '车轮'],
  [/^(Dgn|)AncientBall|^DgnObj_AncientBall_(\d+)$/, (m) => '神庙球' + num(m[2])],
  [/^BokoblinBossPipe$/, '波克布林首领的号角'],
  [/^BokoblinPipe$/, '波克布林的号角'],
  [/^LizalfosPipe$/, '蜥蜴战士的号角'],
  [/^DgnObj_BoardSeesaw_([A-Z])(?:_(Heavy|Unstable))?$/, (m) => '跷跷板 ' + m[1] + ({ Heavy: '（重）', Unstable: '（不稳）' }[m[2]] || '')],
  [/^DgnObj_DoorStone_A(_R)?$/, (m) => '石门' + (m[1] ? '（右）' : '')],
  [/^DgnObj_ElectricSliderMirror_A_(\d+)$/, (m) => '电力滑动镜' + num(m[1])],
  [/^DgnObj_ElectricStatueMirror_A_(\d+)$/, (m) => '电力雕像镜' + num(m[1])],
  [/^DgnObj_ElectricSwitchCapstan_/, '电力绞盘'],
  [/^DgnObj_Fire_BridgeBoard_A_(\d+)$/, (m) => '火之神殿桥板' + num(m[1])],
  [/^DgnObj_GearHandle_/, '齿轮把手'],
  [/^(Dgn|Fld)Obj_HangedLamp_/, '吊灯'],
  [/^DgnObj_HingeBoard_/, '铰链板'],
  [/^DgnObj_SpringHingeBoard_/, '弹簧铰链板'],
  [/^DgnObj_LargeDungeonWater_WaterGateFastener_/, '水之神殿水闸扣件'],
  [/^DgnObj_LargeDungeonWater_WaterGate/, '水之神殿水闸'],
  [/^DgnObj_LargeDungeonWind_Door_/, '风之神殿的门'],
  [/^DgnObj_SpurGear_WithShaft_LargeDungeonWind/, '风之神殿带轴齿轮'],
  [/^DgnObj_SwitchWheel_LargeDugeonWind/, '风之神殿转轮'],
  [/^SwitchGearSmall_LargeDungeonWind_A_(\d+)$/, (m) => '风之神殿小机关齿轮' + num(m[1])],
  [/^(Dgn|Fld)Obj_(DesertRuin)?LeverSwitchBrokenParts_/, '拉杆开关碎片'],
  [/^(Dgn|Fld)Obj_(DesertRuin)?LeverSwitchStick_/, (m) => (m[2] ? '沙漠遗迹的拉杆' : '拉杆')],
  [/^DgnObj_Shaft_/, '轴'],
  [/^DgnObj_(Small_)?SliderBlock_([A-Z])(?:_(\d+))?(_ForRamp|_Light)?$/, (m) => `滑块 ${m[2]}${m[3] ? m[3].replace(/^0/, '') : ''}` + ({ _ForRamp: '（斜坡用）', _Light: '（轻）' }[m[4]] || '')],
  [/^DgnObj_SliderBox_A_(\d+)$/, (m) => '滑动箱' + num(m[1])],
  [/^DgnObj_Small_BoxIron_/, '铁箱'],
  [/^DgnObj_Small_BridgeBoard_A_(\d+)$/, (m) => '桥板' + num(m[1])],
  [/^(Fld|)Obj_(Broken)?BridgeBoard_A_(\d+)$|^FldObj_BrokenBridgeBoard_A_(\d+)$/, (m) => '断桥木板' + num(m[3] || m[4])],
  [/^FldObj_WoodBridgeBoard_/, '木桥板'],
  [/^DgnObj_Small_ClockHand_/, '时钟指针'],
  [/^DgnObj_Small_GolfShaft_/, '球杆'],
  [/^DgnObj_Small_Putter_/, '推杆球杆'],
  [/^(DgnObj_Small_|Obj_Zonau|SkyObj_FirstIsland_Zonau)?SpurGear(Small)?(?:_A_(\d+))?$/, (m) => (m[1] && /Zonau/.test(m[1]) ? '左纳乌' : '') + '齿轮' + (m[2] ? '（小）' : '') + num(m[3])],
  [/^(DgnObj_Small_|Obj_Zonau|SkyObj_FirstIsland_Zonau)?SwitchGear(Small)?(?:_A_(\d+))?$/, (m) => (m[1] && /Zonau/.test(m[1]) ? '左纳乌' : '') + '机关齿轮' + (m[2] ? '（小）' : '') + num(m[3])],
  [/^(DgnObj_Small_)?SwitchGearCylinder(?:_A_(\d+))?$|^DgnObj_SwitchGearCylinder$/, (m) => '圆筒机关齿轮' + num(m[2])],
  [/^(DgnObj_Small_|DgnObj_)?SwitchCapstan_([A-Z])(?:_(\d+))?$/, (m) => '绞盘 ' + m[2] + (m[3] ? m[3].replace(/^0/, '') : '')],
  [/^SkyObj_Firone_Raimei_Capstan_A_(\d+)$/, (m) => '雷鸣岛绞盘' + num(m[1])],
  [/^(DgnObj_Small_)?WaterWheel_A_(\d+)$|^SwitchWaterWheel_A$/, (m) => '水车' + num(m[2])],
  [/^DgnObj_SwitchHitGravity/, '重力击打开关'],
  [/^DgnObj_Zonau_Fan_A_(\d+)$/, (m) => '神庙风扇' + num(m[1])],
  [/^DgnObj_Zonau_RaiseDoor_Block_/, '升降门方块'],
  [/^DgnObj_Zonau_RaiseDoor_/, '左纳乌升降门'],
  [/^DgnObj_Zonau_SliderBox_A_02$/, '轻质栏杆（左纳乌格栅板）'],
  [/^DgnObj_Zonau_SliderBox_A_(\d+)$/, (m) => '左纳乌滑动箱' + num(m[1])],
  [/^FldObj_CannonTerminal_/, '炮台终端'],
  [/^FldObj_HyliaStoneRuinBoard_/, '海利亚石造遗迹板'],
  [/^FldObj_KorokPlugFloat_/, '克洛格浮塞'],
  [/^FldObj_KorokPlug_/, '克洛格塞子'],
  [/^FldObj_ShootingStar/, '流星'],
  [/^FldObj_StairWood_/, '木楼梯'],
  [/^FldObj_ZonauShrine_KeyCrystal/, '神庙水晶'],
  [/^GroundControlObject_FreeMotion(?:_(\d+))?$/, (m) => '自由移动物体' + num(m[1])],
  [/^Harness_Coupler/, '马车连接器'],
  [/^Helmet_(\d+)$/, '头盔'],
  [/^Item_Mushroom_([A-Z])$/, (m) => '蘑菇 ' + m[1]],
  [/^KorokStoneBlockMerge_Base/, '克洛格石块底座'],
  [/^LightBallBud_(Large|Small)$/, (m) => '光亮花花苞' + (m[1] === 'Large' ? '（大）' : '（小）')],
  [/^LotusLeaf$/, '莲叶'],
  [/^Obj_AirPlatform_/, '浮空平台'],
  [/^Obj_ArrowNormal_/, '箭'],
  [/^Obj_BoneWhale_A_(\d+)$/, (m) => '鲸骨' + num(m[1])],
  [/^Obj_GerdoElevatorStep_B_(\d+)$/, (m) => '格鲁德升降踏板' + num(m[1])],
  [/^Obj_GerudoStatueBall_A_(\d+)$/, (m) => '格鲁德雕像球' + num(m[1])],
  [/^Obj_KorokPot_/, '克洛格的壶'],
  [/^Obj_LadderParts_A_(\d+)$/, (m) => '梯子部件' + num(m[1])],
  [/^Obj_RaftWood_A_(\d+)$/, (m) => '木筏' + num(m[1])],
  [/^Obj_RaumiGolem_Parts_(Arm|Leg)_([LR])_/, (m) => `米涅鲁魔像的${side(m[2])}${m[1] === 'Arm' ? '臂' : '腿'}`],
  [/^RaumiGolem_Parts_Head(?:_([AB]))?$/, (m) => '米涅鲁魔像的头部' + (m[1] ? ' ' + m[1] : '')],
  [/^Obj_RockZoraRelief_Piece_/, '佐拉浮雕碎片'],
  [/^Obj_Sunazarashi_Sled/, '沙海豹雪橇'],
  [/^Obj_ZonauContainer_A_(\d+)$/, (m) => '左纳乌容器' + num(m[1])],
  [/^RockRollA_Heavy/, '滚石（重）'],
  [/^RockRollA$/, '滚石'],
  [/^DgnObj_StoneBall_NoFire$/, '石球'],
  [/^SmokeFuit_Static$/, '烟雾果'],
  [/^Item_CatchInAir$/, '空中接物'],
  [/^AsbObj_Base$/, '建造底座'],
  [/^SkyObj_AncientMemoryIsland_A_(\d+)$/, (m) => '空岛遗迹碎块' + num(m[1])],
  [/^SpObj_BalloonEnvelope_A_(\d+)$/, (m) => '热气球' + num(m[1])],
  [/^TwnObj_DemonStatuePart_A_(\d+)$/, (m) => '魔像雕像碎片' + num(m[1])],
  [/^TwnObj_HyruleCastleObject_SelectorSwitchBrokenParts_/, '海拉鲁城开关碎片'],
  [/^TwnObj_HyruleCastleObject_ShatterFence_Wood_/, '海拉鲁城木栅栏'],
  [/^TwnObj_HyruleCastleObject_ShutterFence_Iron_/, '海拉鲁城铁栅门'],
  [/^TwnObj_HyruleCastleUnderpassExitCover_/, '海拉鲁城地道出口格栅'],
  [/^TwnObj_HyruleCastleWallGate_OpenDoor([LR])_/, (m) => `海拉鲁城城门（${side(m[1])}）`],
  [/^TwnObj_HyruleCastle_GateBridgeDoor([LR])_/, (m) => `海拉鲁城吊桥门（${side(m[1])}）`],
  [/^TwnObj_HyruleCastle_Bell_/, '海拉鲁城的钟'],
  [/^TwnObj_StoneBall_/, '石球'],
  [/^TwnObj_Village_FishingBoatShop_/, '渔村的船'],
  [/^TwnObj_Village_HatenoBell_/, '哈特诺村的钟'],
  [/^TwnObj_Village_IchikaraBell_/, '一始村的钟'],
  [/^Wizzrobe_WeatherFireBall/, '长袍魔法师的火球'],
  [/^Energy_Material_(\d+)$/, (m) => '左纳乌能源材料' + num(m[1])],
  [/^Weapon_(Sword|Lsword|Spear|Bow|Shield)_(\d+)(_Broken|_Main|_Sub)?$/, (m) => ({ Sword: '单手剑', Lsword: '双手剑', Spear: '长枪', Bow: '弓', Shield: '盾' }[m[1]]) + ' ' + m[2] + ({ _Broken: '（损坏）', _Main: '（主）', _Sub: '（副）' }[m[3]] || '')],
];

// Treasure chests: 宝箱（铁、已打开） etc.
function chestName(actor) {
  const m = actor.match(/^TBox_(Field|Dungeon)_(Iron|Stone|Wood|Enemy|Gamble)(.*)$/);
  if (!m) return null;
  const kind = { Iron: '铁', Stone: '石', Wood: '木', Enemy: '敌营', Gamble: '赌博' }[m[2]];
  const tags = [];
  if (m[1] === 'Dungeon') tags.push('神庙');
  if (/Zonau/.test(m[3])) tags.push('左纳乌');
  if (/Assassin/.test(m[3])) tags.push('依盖队');
  if (/Miasma/.test(m[3])) tags.push('瘴气');
  if (/Opened/.test(m[3])) tags.push('已打开');
  if (/CanNotOpen/.test(m[3])) tags.push('打不开');
  return `${kind}宝箱` + (tags.length ? `（${tags.join('、')}）` : '');
}

class Namer {
  /** lang: the message language, 'CNzh' (default) or 'USen'. */
  constructor(romfs, reader, lang = 'CNzh') {
    this.reader = reader;
    this.zh = lang === 'CNzh';
    const s = parseSarc(romfs.read(romfs.list(new RegExp('^Mals/' + lang + '\\.'))[0]));
    this.names = new Map(); // actor -> name, first file wins (FIRST before the rest)
    this.common = {};
    const files = [...FIRST, ...[...s.keys()].filter((f) => f.endsWith('.msbt') && !FIRST.includes(f)).sort()];
    for (const f of files) {
      let m;
      try { m = parseMsbt(s.get(f)); } catch { continue; }
      for (const [k, v] of Object.entries(m)) {
        if (!/_Name$/.test(k) || !v) continue;
        if (f === 'StaticMsg/AttachmentCommonName.msbt') this.common[k.slice(0, -5)] = String(v);
        else if (!this.names.has(k.slice(0, -5))) this.names.set(k.slice(0, -5), String(v));
      }
    }
  }

  /** The name text of an actor or of the actor it is a variant of (trailing name parts cut off). */
  official(actor) {
    if (this.names.has(actor)) return this.names.get(actor);
    let a = actor;
    while (/_[^_]+$/.test(a)) {
      a = a.replace(/_[^_]+$/, '');
      if (this.names.has(a)) return this.names.get(a);
    }
    return null;
  }

  /**
   * The fuse common name from the actor's AttachmentParam. The shared parent "General" carries a default (IronBall) that
   * many unrelated parts inherit, so a name counts only when the actor's own file or a more specific parent sets it.
   */
  commonName(actor) {
    try {
      const { parseByml } = require('./byml');
      const pack = this.reader.open(actor);
      const C = (pack.actorParam() || {}).Components || {};
      let ref = C.AttachmentRef;
      for (let depth = 0; ref && depth < 8; depth++) {
        const inner = ref.replace(/^\?/, '').replace(/^Work\//, '').replace(/\.gyml$/, '.bgyml');
        // the shared default (IronBall) fits only balls
        if (/AttachmentParam\/General\./.test(inner) && !/Ball/.test(actor)) return null;
        const buf = pack.raw(inner);
        if (!buf) return null;
        const v = parseByml(buf).root || {};
        if (v.CommonName) return this.common[v.CommonName] || null;
        ref = v.$parent;
      }
      return null;
    } catch { return null; }
  }

  /** The text name of a numbered sibling (SpObj_ControlStick_A_02 -> SpObj_ControlStick_A_01). */
  sibling(actor) {
    const m = actor.match(/^(.*_)(\d+)$/);
    if (!m || /^Weapon_/.test(actor)) return null; // weapon numbers are different weapons
    for (let k = 1; k <= 9; k++) {
      const a = m[1] + String(k).padStart(m[2].length, '0');
      if (a !== actor && this.names.has(a)) return this.names.get(a);
    }
    return null;
  }

  /** { name, source }: source 'game' (the actor's own text), 'common' (fuse common name) or 'guess'. */
  name(actor) {
    const own = this.official(actor);
    if (own) return { name: own, source: 'game' };
    if (this.common[actor]) return { name: this.common[actor], source: 'game' }; // IronBall, Barrel, Pot, ...
    const sib = this.sibling(actor);
    if (sib) return { name: sib, source: 'game' };
    if (!this.zh) {
      // English: the game's fuse common name, if any; otherwise no name (the actor name is shown)
      const common = this.commonName(actor);
      return common ? { name: common, source: 'common' } : { name: actor, source: 'none' };
    }
    const mat = materialName(actor);
    if (mat) return { name: mat, source: 'guess' };
    // enemy figurines (Kilton's monster figures): the enemy's name
    const fig = actor.match(/^FldObj_Figure_(Enemy_.+?)(_Head)?$/);
    if (fig) {
      // a size variant without its own text: the small one's name with the size (丘丘模型（大）)
      const sized = fig[1].match(/^(.+)_(Middle|Senior)$/);
      if (sized && !this.names.has(fig[1]) && this.names.has(sized[1] + '_Junior')) {
        return { name: this.names.get(sized[1] + '_Junior') + '模型' + (sized[2] === 'Middle' ? '（中）' : '（大）'), source: 'guess' };
      }
      // a kind without text (Treant_D): another of the family (Treant_Broadleaf)
      const fam = fig[1].match(/^(Enemy_[^_]+)_([A-Z])$/);
      if (fam && !this.names.has(fig[1])) {
        const k = [...this.names.keys()].find((x) => x.startsWith(fam[1] + '_'));
        if (k) return { name: this.names.get(k) + '模型 ' + fam[2], source: 'guess' };
      }
      let a = fig[1], rest = '';
      while (!this.names.has(a) && /_[^_]+$/.test(a)) { rest = a.match(/_[^_]+$/)[0] + rest; a = a.replace(/_[^_]+$/, ''); }
      if (this.names.has(a)) {
        const extra = { _Bullet_Shark: '鲨鱼弹', _Bullet_SharkFin: '鲨鳍弹', _Miasma: '瘴气', _Plane: '平地', _Crack: '裂缝', _Fort_A: '要塞' }[rest];
        return { name: this.names.get(a) + '模型' + (extra ? `（${extra}）` : '') + (fig[2] ? '（头）' : ''), source: 'guess' };
      }
    }
    const core = actor.match(/^Zonau_BlockMaster_CoreBlock(?:_(Middle|Senior))?$/);
    if (core) {
      const n = this.names.get('Enemy_Zonau_BlockMaster_' + (core[1] || 'Junior'));
      if (n) return { name: n + '的核心方块', source: 'guess' };
    }
    const common = this.commonName(actor);
    if (common) return { name: common, source: 'common' };
    const chest = chestName(actor);
    if (chest) return { name: chest, source: 'guess' };
    for (const [re, v] of RULES) {
      const m = actor.match(re);
      if (m) return { name: typeof v === 'function' ? v(m) : v, source: 'guess' };
    }
    return { name: actor, source: 'none' };
  }
}

module.exports = { Namer };
