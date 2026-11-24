# 蓝图导入窗口：选择 .cai / .cmbact 文件，写进 TotK 存档的究极建造历史。
# 由 import-blueprint.cmd 启动；实际读写存档由 import_backend.js / save_inject.js 完成（先备份，游戏必须退出）。
#   powershell -File tools\import_gui.ps1 [蓝图文件...]       打开窗口（文件会加进列表并选中）
#   powershell -File tools\import_gui.ps1 -SelfTest out.png   不显示窗口，载入后把界面画到图片（用于检查）
param(
  [string]$SelfTest = '',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Files = @()
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Win32.Dpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$backend = Join-Path $PSScriptRoot 'import_backend.js'
# the release's own Node (node\node.exe next to tools\) if there is one, else the installed one
$bundled = Join-Path (Split-Path $PSScriptRoot -Parent) 'node\node.exe'
if (Test-Path -LiteralPath $bundled) {
  $node = $bundled
} else {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    [System.Windows.Forms.MessageBox]::Show('找不到 node。请先安装 Node.js 并确认 node 在 PATH 里。', '蓝图导入') | Out-Null
    exit 1
  }
  $node = $nodeCmd.Source
}

$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$scale = $g.DpiX / 96.0
$g.Dispose()
function S([double]$n) { [int][Math]::Round($n * $scale) }

$script:extra = New-Object System.Collections.Generic.List[string]
foreach ($f in $Files) { if ($f -and (Test-Path -LiteralPath $f)) { $script:extra.Add((Resolve-Path -LiteralPath $f).Path) } }
$script:state = $null
$script:plan = $null
$script:loading = $false

function Invoke-Backend([string[]]$argList) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $quoted = @($backend) + $argList | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
  $psi.Arguments = $quoted -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if (-not $out) { return [pscustomobject]@{ ok = $false; error = "后台程序没有输出。$err" } }
  try { return $out | ConvertFrom-Json } catch { return [pscustomobject]@{ ok = $false; error = "后台输出无法解析：$out" } }
}

function Format-Time([string]$iso) {
  try { return ([DateTime]::Parse($iso)).ToLocalTime().ToString('yyyy-MM-dd HH:mm') } catch { return $iso }
}

# ---------- window ----------
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$bold = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$form = New-Object System.Windows.Forms.Form
$form.Text = '究极建造蓝图导入'
$form.Font = $font
$form.AutoScaleMode = 'None'
$form.Size = New-Object System.Drawing.Size((S 1060), (S 680))
$form.MinimumSize = New-Object System.Drawing.Size((S 820), (S 520))
$form.StartPosition = 'CenterScreen'
$form.AllowDrop = $true

$warn = New-Object System.Windows.Forms.Label
$warn.Dock = 'Top'
$warn.Height = S 30
$warn.TextAlign = 'MiddleCenter'
$warn.BackColor = [System.Drawing.Color]::FromArgb(255, 235, 230)
$warn.ForeColor = [System.Drawing.Color]::FromArgb(170, 30, 20)
$warn.Font = $bold
$warn.Text = '游戏正在运行。导入前请先退出游戏（游戏退出时会覆盖存档）。'
$warn.Visible = $false

$split = New-Object System.Windows.Forms.SplitContainer
$split.Dock = 'Fill'
$split.Orientation = 'Vertical'
$split.Padding = New-Object System.Windows.Forms.Padding((S 8), (S 6), (S 8), 0)

# left: blueprint files
$filesBox = New-Object System.Windows.Forms.GroupBox
$filesBox.Text = '蓝图文件（选一个要导入的）'
$filesBox.Dock = 'Fill'
$filesBox.Padding = New-Object System.Windows.Forms.Padding((S 6))
$fileList = New-Object System.Windows.Forms.ListView
$fileList.View = 'Details'
$fileList.FullRowSelect = $true
$fileList.MultiSelect = $false
$fileList.HideSelection = $false
$fileList.Dock = 'Fill'
[void]$fileList.Columns.Add('文件', (S 160))
[void]$fileList.Columns.Add('修改时间', (S 120))
[void]$fileList.Columns.Add('零件', (S 46))
[void]$fileList.Columns.Add('状态', (S 120))
$fileButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$fileButtons.Dock = 'Bottom'
$fileButtons.Height = S 40
$fileButtons.Padding = New-Object System.Windows.Forms.Padding(0, (S 4), 0, 0)
function New-Button([string]$text, [int]$w) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Width = S $w
  $b.Height = S 30
  return $b
}
$browseBtn = New-Button '浏览其他文件…' 120
$folderBtn = New-Button '打开蓝图文件夹' 120
$refreshBtn = New-Button '刷新' 70
$fileButtons.Controls.AddRange(@($browseBtn, $folderBtn, $refreshBtn))
$filesBox.Controls.Add($fileList)
$filesBox.Controls.Add($fileButtons)
$split.Panel1.Controls.Add($filesBox)

# right: slot, history, details
$right = New-Object System.Windows.Forms.TableLayoutPanel
$right.Dock = 'Fill'
$right.ColumnCount = 1
$right.RowCount = 3
[void]$right.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Absolute', (S 40))))
[void]$right.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 55)))
[void]$right.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 45)))

$slotRow = New-Object System.Windows.Forms.FlowLayoutPanel
$slotRow.Dock = 'Fill'
$slotLabel = New-Object System.Windows.Forms.Label
$slotLabel.Text = '存档槽'
$slotLabel.AutoSize = $true
$slotLabel.Margin = New-Object System.Windows.Forms.Padding(0, (S 9), (S 6), 0)
$slotCombo = New-Object System.Windows.Forms.ComboBox
$slotCombo.DropDownStyle = 'DropDownList'
$slotCombo.Width = S 300
$slotCombo.Margin = New-Object System.Windows.Forms.Padding(0, (S 5), 0, 0)
$slotRow.Controls.AddRange(@($slotLabel, $slotCombo))

$histBox = New-Object System.Windows.Forms.GroupBox
$histBox.Text = '这个存档槽现在的究极建造历史'
$histBox.Dock = 'Fill'
$histList = New-Object System.Windows.Forms.ListView
$histList.View = 'Details'
$histList.FullRowSelect = $true
$histList.Dock = 'Fill'
[void]$histList.Columns.Add('顺序', (S 52))
[void]$histList.Columns.Add('条目', (S 48))
[void]$histList.Columns.Add('零件', (S 46))
[void]$histList.Columns.Add('内容', (S 330))
$histBox.Controls.Add($histList)

$detailBox = New-Object System.Windows.Forms.GroupBox
$detailBox.Text = '选中的蓝图'
$detailBox.Dock = 'Fill'
$detail = New-Object System.Windows.Forms.TextBox
$detail.Multiline = $true
$detail.ReadOnly = $true
$detail.ScrollBars = 'Vertical'
$detail.Dock = 'Fill'
$detail.BackColor = [System.Drawing.SystemColors]::Window
$detailBox.Controls.Add($detail)

$right.Controls.Add($slotRow, 0, 0)
$right.Controls.Add($histBox, 0, 1)
$right.Controls.Add($detailBox, 0, 2)
$split.Panel2.Controls.Add($right)

# bottom: import
$bottom = New-Object System.Windows.Forms.Panel
$bottom.Dock = 'Bottom'
$bottom.Height = S 56
$bottom.Padding = New-Object System.Windows.Forms.Padding((S 10), (S 8), (S 10), (S 10))
$importBtn = New-Button '导入到存档' 150
$importBtn.Dock = 'Right'
$importBtn.Height = S 38
$importBtn.Font = $bold
$importBtn.Enabled = $false
$forceBox = New-Object System.Windows.Forms.CheckBox
$forceBox.Text = '已在历史里也再导入一份'
$forceBox.AutoSize = $true
$forceBox.Dock = 'Right'
$forceBox.Padding = New-Object System.Windows.Forms.Padding(0, (S 8), (S 12), 0)
$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Fill'
$status.TextAlign = 'MiddleLeft'
$bottom.Controls.Add($status)
$bottom.Controls.Add($forceBox)
$bottom.Controls.Add($importBtn)

$form.Controls.Add($split)
$form.Controls.Add($bottom)
$form.Controls.Add($warn)

# ---------- behaviour ----------
function Get-SelectedFile {
  if ($fileList.SelectedItems.Count -eq 0) { return $null }
  return $fileList.SelectedItems[0].Tag
}

function Status-Text($f) {
  if (-not $f.ok) { return '无法读取' }
  switch ($f.status) {
    'same' { return "已在历史 #$($f.entry)" }
    'similar' { return "可能已导入 #$($f.entry)" }
    default { return '未导入' }
  }
}

function Load-State([string]$keepPath) {
  $form.Cursor = 'WaitCursor'
  try {
    $args = @('state')
    if ($slotCombo.SelectedItem) { $args += @('--slot', $slotCombo.SelectedItem.Slot) }
    foreach ($e in $script:extra) { $args += @('--extra', $e) }
    $st = Invoke-Backend $args
    if (-not $st.ok) { $status.Text = '读取存档失败：' + $st.error; return }
    $script:state = $st
    $script:loading = $true
    $warn.Visible = [bool]$st.gameRunning

    $slotCombo.Items.Clear()
    $i = 0
    foreach ($s in @($st.slots)) {
      $label = "slot_$($s.slot)    最后保存 $(Format-Time $s.savedAt)" + $(if ($i -eq 0) { '（最新）' } else { '' })
      $item = [pscustomobject]@{ Slot = $s.slot; Label = $label }
      $item | Add-Member ScriptMethod ToString { $this.Label } -Force
      [void]$slotCombo.Items.Add($item)
      if ($s.slot -eq $st.slot) { $slotCombo.SelectedIndex = $i }
      $i++
    }

    $histBox.Text = "这个存档槽现在的究极建造历史（$($st.used) / $($st.capacity) 条，顺序 0 是最新）"
    $histList.BeginUpdate()
    $histList.Items.Clear()
    foreach ($h in @($st.history)) {
      $it = New-Object System.Windows.Forms.ListViewItem([string]$h.order)
      [void]$it.SubItems.Add([string]$h.index)
      [void]$it.SubItems.Add([string]$h.parts)
      [void]$it.SubItems.Add([string]$h.text)
      [void]$histList.Items.Add($it)
    }
    $histList.EndUpdate()

    $fileList.BeginUpdate()
    $fileList.Items.Clear()
    $select = $null
    foreach ($f in @($st.files)) {
      $it = New-Object System.Windows.Forms.ListViewItem([string]$f.name)
      [void]$it.SubItems.Add((Format-Time $f.modified))
      [void]$it.SubItems.Add($(if ($f.ok) { [string]$f.parts } else { '' }))
      [void]$it.SubItems.Add((Status-Text $f))
      $it.Tag = $f
      $it.ToolTipText = $f.path
      if (-not $f.ok) { $it.ForeColor = [System.Drawing.Color]::Gray }
      elseif ($f.status -ne 'new') { $it.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110) }
      [void]$fileList.Items.Add($it)
      if ($keepPath -and $f.path -eq $keepPath) { $select = $it }
    }
    $fileList.EndUpdate()
    $fileList.ShowItemToolTips = $true
    $script:loading = $false
    if (-not $select -and $fileList.Items.Count -gt 0 -and -not $keepPath) { $select = $fileList.Items[0] }
    if ($select) { $select.Selected = $true; $select.EnsureVisible() } else { Show-Plan }
    $status.Text = "存档：$($st.slotDir)"
  } finally {
    $script:loading = $false
    $form.Cursor = 'Default'
  }
}

function Show-Plan {
  $f = Get-SelectedFile
  $script:plan = $null
  $importBtn.Enabled = $false
  if (-not $f) { $detail.Text = '在左边选一个蓝图文件。也可以把 .cai 文件拖到这个窗口上。'; return }
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("文件：$($f.path)")
  $lines.Add("修改时间：$(Format-Time $f.modified)")
  if (-not $f.ok) {
    $lines.Add('')
    $lines.Add("这个文件不能导入：$($f.error)")
    $detail.Text = $lines -join "`r`n"
    return
  }
  $lines.Add("内容：$($f.parts) 个零件、$($f.bonds) 条粘合")
  $lines.Add("　　$($f.text)")
  $lines.Add('')
  $form.Cursor = 'WaitCursor'
  $args = @('plan', $f.path, '--slot', $script:state.slot)
  if ($forceBox.Checked) { $args += '--force' }
  $p = Invoke-Backend $args
  $form.Cursor = 'Default'
  if ($p.ok) {
    $lines.Add("导入后：写进 slot_$($p.slot) 的条目 $($p.index)，排在历史最前面。")
    if ($p.dup -ge 0) { $lines.Add("注意：历史条目 $($p.dup) 和它完全相同，会再多一份。") }
    elseif ($p.similar -ge 0) { $lines.Add("注意：历史条目 $($p.similar) 的零件和粘合与它相同，可能已经导入过（游戏建造后会微调保存的位置）。") }
    $lines.Add('导入前会先把这个存档槽备份到 backups 文件夹。')
    $script:plan = $p
    $importBtn.Enabled = $true
  } else {
    $lines.Add("不能导入：$($p.error)")
    if ($f.status -eq 'same') { $lines.Add('如果确实要再导入一份，勾选右下角「已在历史里也再导入一份」。') }
  }
  $detail.Text = $lines -join "`r`n"
}

function Add-Files([string[]]$paths) {
  $last = $null
  foreach ($p in $paths) {
    if ($p -match '\.(cai|cmbact)$' -and (Test-Path -LiteralPath $p)) {
      $full = (Resolve-Path -LiteralPath $p).Path
      if (-not $script:extra.Contains($full)) { $script:extra.Add($full) }
      $last = $full
    }
  }
  if ($last) { Load-State $last } else { $status.Text = '只能添加 .cai 或 .cmbact 文件。' }
}

$fileList.add_SelectedIndexChanged({ if (-not $script:loading) { Show-Plan } })
$forceBox.add_CheckedChanged({ Show-Plan })
$slotCombo.add_SelectionChangeCommitted({ $f = Get-SelectedFile; Load-State $(if ($f) { $f.path } else { '' }) })
$refreshBtn.add_Click({ $f = Get-SelectedFile; Load-State $(if ($f) { $f.path } else { '' }) })
$folderBtn.add_Click({
  if ($script:state -and (Test-Path -LiteralPath $script:state.blueprintDir)) { Start-Process explorer.exe $script:state.blueprintDir }
})
$browseBtn.add_Click({
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = '选择蓝图文件'
  $dlg.Filter = '蓝图 (*.cai;*.cmbact)|*.cai;*.cmbact|所有文件 (*.*)|*.*'
  if ($script:state) { $dlg.InitialDirectory = $script:state.blueprintDir }
  if ($dlg.ShowDialog($form) -eq 'OK') { Add-Files @($dlg.FileName) }
})
$form.add_DragEnter({ param($s, $e) if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) { $e.Effect = 'Copy' } })
$form.add_DragDrop({ param($s, $e) Add-Files ([string[]]$e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)) })

$importBtn.add_Click({
  $f = Get-SelectedFile
  if (-not $f -or -not $script:plan) { return }
  $msg = "把 $($f.name) 导入 slot_$($script:state.slot)？`r`n`r`n$($f.parts) 个零件：$($f.text)`r`n`r`n导入前会自动备份这个存档槽。请确认游戏已经退出。"
  if ([System.Windows.Forms.MessageBox]::Show($form, $msg, '确认导入', 'YesNo', 'Question') -ne 'Yes') { return }
  $form.Cursor = 'WaitCursor'
  $args = @('write', $f.path, '--slot', $script:state.slot)
  if ($forceBox.Checked) { $args += '--force' }
  $r = Invoke-Backend $args
  $form.Cursor = 'Default'
  if ($r.ok) {
    [System.Windows.Forms.MessageBox]::Show($form, "已导入到 slot_$($r.slot) 的条目 $($r.index)，排在历史最前面。`r`n`r`n备份：$($r.backup)`r`n`r`n进游戏读取这个存档，在究极建造的「历史」里就能看到。", '导入完成', 'OK', 'Information') | Out-Null
    $forceBox.Checked = $false
    Load-State $f.path
    $status.Text = "已导入 $($f.name)。备份：$($r.backup)"
  } else {
    [System.Windows.Forms.MessageBox]::Show($form, "没有导入：$($r.error)", '导入失败', 'OK', 'Warning') | Out-Null
    Load-State $f.path
  }
})

$form.add_Load({
  $split.SplitterDistance = S 430
  $keep = ''
  if ($script:extra.Count -gt 0) { $keep = $script:extra[$script:extra.Count - 1] }
  Load-State $keep
})

if ($SelfTest) {
  $form.StartPosition = 'Manual'
  $form.Location = New-Object System.Drawing.Point(-20000, -20000)
  $form.ShowInTaskbar = $false
  $form.add_Shown({
    [System.Windows.Forms.Application]::DoEvents()
    $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
    $bmp.Save($SelfTest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    [Console]::Out.WriteLine(("files={0} history={1} slot={2} import={3} scale={4}" -f $fileList.Items.Count, $histList.Items.Count, $script:state.slot, $importBtn.Enabled, $scale))
    [Console]::Out.WriteLine($detail.Text)
    $form.Close()
  })
}

[void]$form.ShowDialog()
