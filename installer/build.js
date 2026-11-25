// Збирає власний інсталятор. Нічого додатково встановлювати не треба:
// компілятор csc.exe і WPF уже є в Windows разом із .NET Framework 4.
//
//   node installer/build.js             повний інсталятор (потрібен готовий NSIS у dist/)
//   node installer/build.js --preview   тільки вікно, без програми всередині (для роботи над дизайном)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const preview = process.argv.includes('--preview');

function fail(message) {
  console.error('Помилка: ' + message);
  process.exit(1);
}

if (process.platform !== 'win32') fail('власний інсталятор збирається лише на Windows.');

const framework = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = path.join(framework, 'csc.exe');
if (!fs.existsSync(csc)) fail('не знайдено ' + csc);

const guid = pkg.build.nsis.guid;
if (!guid) fail('у package.json немає build.nsis.guid.');

const dist = path.join(root, 'dist');
const objDir = path.join(dist, 'installer-obj');
fs.mkdirSync(objDir, { recursive: true });

const payload = path.join(dist, `DevBridge-Setup-${pkg.version}.exe`);
if (!preview && !fs.existsSync(payload)) {
  fail(`немає ${path.relative(root, payload)}. Спочатку запусти: npm run dist:installer`);
}

// скільки місця займе встановлена програма (рахуємо з розпакованої збірки)
function folderSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? folderSize(full) : fs.statSync(full).size);
  }, 0);
}
const requiredBytes = folderSize(path.join(dist, 'win-unpacked'));

// значення з package.json потрапляють у код через згенерований файл
const text = (value) => JSON.stringify(String(value));
const generated = path.join(objDir, 'BuildInfo.g.cs');
fs.writeFileSync(generated, `// Згенеровано build.js. Не редагуйте.
using System.Reflection;
[assembly: AssemblyTitle("Встановлення DevBridge")]
[assembly: AssemblyProduct("DevBridge")]
[assembly: AssemblyCompany(${text(pkg.author)})]
[assembly: AssemblyCopyright(${text(pkg.build.copyright)})]
[assembly: AssemblyVersion(${text(pkg.version + '.0')})]
[assembly: AssemblyFileVersion(${text(pkg.version + '.0')})]
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

namespace DevBridgeSetup
{
    static class BuildInfo
    {
        public const string Version = ${text(pkg.version)};
        public const string AppGuid = ${text(guid)};
        public static readonly long RequiredBytes = ${requiredBytes}L;
    }
}
`);

const output = path.join(dist, preview ? 'DevBridge-Installer-preview.exe' : `DevBridge-Installer-${pkg.version}.exe`);
const wpf = path.join(framework, 'WPF');
const here = (file) => path.join(__dirname, file);

const args = [
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
  `/out:${output}`,
  `/win32icon:${path.join(root, 'build', 'icon.ico')}`,
  `/win32manifest:${here('app.manifest')}`,
  `/reference:${path.join(wpf, 'PresentationFramework.dll')}`,
  `/reference:${path.join(wpf, 'PresentationCore.dll')}`,
  `/reference:${path.join(wpf, 'WindowsBase.dll')}`,
  `/reference:${path.join(framework, 'System.Xaml.dll')}`,
  `/resource:${here('ui.xaml')},ui.xaml`,
  `/resource:${path.join(root, 'src', 'assets', 'logo-64.png')},logo.png`,
  ...(preview ? [] : [`/resource:${payload},payload.exe`]),
  here('Installer.cs'), here('InstallPath.cs'), here('FolderPicker.cs'), generated,
];

try {
  execFileSync(csc, args, { stdio: 'inherit' });
} catch {
  fail('компіляція не вдалася (дивись повідомлення csc вище).');
}

const mb = (fs.statSync(output).size / 1048576).toFixed(1);
console.log(`Готово: ${path.relative(root, output)} (${mb} МБ)`);
