import { execFile } from 'node:child_process';
import { HttpError } from './errors.ts';

/**
 * 通过 PowerShell 调出系统「选择文件夹」对话框（本工具仅限 Windows +
 * 本机浏览器，后端代开对话框即可全平台浏览器可用）。
 * TopMost 隐藏窗体作为 owner，防止对话框被浏览器窗口遮挡。
 */
const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择目标目录（落选图片移动至此）'
$dlg.ShowNewFolderButton = $true
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
	[Console]::Out.Write($dlg.SelectedPath)
}
`;

/** 对话框是模态阻塞的，同一时刻只允许一个（浏览器多标签页防护）。 */
let picking = false;

/** 调出系统文件夹选择对话框；用户取消时返回 null。 */
export async function pickFolder(): Promise<string | null> {
	if (process.platform !== 'win32') {
		throw new HttpError(501, '文件夹选择对话框仅支持 Windows');
	}
	if (picking) {
		throw new HttpError(409, '文件夹选择对话框已打开，请先完成选择');
	}
	picking = true;
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				'powershell.exe',
				['-NoProfile', '-STA', '-Command', PS_SCRIPT],
				{ timeout: 300_000, windowsHide: true, maxBuffer: 1024 * 64 },
				(err, stdout) => {
					if (err) reject(err);
					else resolve(String(stdout));
				},
			);
		});
		const path = stdout.trim();
		return path ? path : null;
	} finally {
		picking = false;
	}
}
