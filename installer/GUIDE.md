# Власний інсталятор: як зробити самому

Посібник пояснює, як влаштований інсталятор DevBridge, як його змінювати і як з нуля зробити такий самий для іншої програми на Electron.

**Зміст**

1. [Як це працює](#1-як-це-працює)
2. [Що потрібно](#2-що-потрібно)
3. [Швидкий старт](#3-швидкий-старт)
4. [Створення з нуля, крок за кроком](#4-створення-з-нуля-крок-за-кроком)
5. [Як змінювати дизайн](#5-як-змінювати-дизайн)
6. [Як додати нову опцію](#6-як-додати-нову-опцію)
7. [Перевірка перед випуском](#7-перевірка-перед-випуском)
8. [Перенесення в інший проєкт](#8-перенесення-в-інший-проєкт)
9. [Типові помилки](#9-типові-помилки)
10. [Обмеження](#10-обмеження)

---

## 1. Як це працює

Ідея: **не писати встановлення самому, а намалювати власне вікно поверх готового інсталятора.**

```
DevBridge-Installer-1.1.0.exe        ← віддаєте користувачам
├── вікно (WPF)                      ← те, що бачить користувач
│   ├── ui.xaml                         дизайн
│   └── Installer.cs                    логіка
└── payload.exe                      ← звичайний NSIS-інсталятор усередині
```

Після кнопки «Встановити» вікно:

1. розпаковує `payload.exe` у нову тимчасову теку;
2. запускає його тихо:
   ```
   setup.exe /S /currentuser [--no-desktop-shortcut] /D=C:\шлях\DevBridge
   ```
3. чекає завершення, перевіряє код виходу й наявність `DevBridge.exe`;
4. видаляє тимчасову теку та показує результат.

| Параметр | Що означає |
|---|---|
| `/S` | тихий режим, без вікон майстра (велика літера) |
| `/currentuser` | тільки для поточного користувача, без прав адміністратора |
| `--no-desktop-shortcut` | не створювати ярлик на робочому столі (параметр `electron-builder`) |
| `/D=...` | тека встановлення. **Тільки останнім і без лапок**, навіть якщо є пробіли |

Файли, реєстр, ярлики, оновлення старої версії та деінсталятор залишаються роботою NSIS.

**Чому WPF.** `csc.exe` і WPF уже є у Windows 10 та 11 разом із .NET Framework 4. Нічого встановлювати не треба, на комп'ютері користувача теж, а саме вікно додає лише близько 0,1 МБ. Оболонка на Electron зробила б файл набагато важчим, а для Tauri потрібен Rust.

### Файли

| Файл | Для чого |
|---|---|
| `installer/ui.xaml` | кольори, стилі, розмітка всіх екранів |
| `installer/Installer.cs` | кнопки, запуск NSIS, анімація, демо-режим, знімки екранів |
| `installer/InstallPath.cs` | перевірка теки встановлення (**захист файлів**) |
| `installer/FolderPicker.cs` | сучасний діалог вибору теки |
| `installer/app.manifest` | запуск без прав адміністратора, чіткість на HiDPI |
| `installer/build.js` | збирання |

---

## 2. Що потрібно

- Windows 10 або 11 (x64).
- Node.js 20+ і виконаний `npm install`.
- Для редагування досить будь-якого редактора, Visual Studio не потрібна.

Перевірити, чи є компілятор:

```powershell
Test-Path "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
```

> **Важливо:** цей компілятор старий і розуміє лише **C# 5**. Не працюють `$"текст {x}"`, `?.`, `nameof`, `=>` замість тіла методу, `out var`. Пишіть `"текст " + x`, `if (x != null)` і оголошуйте змінну перед `out`.

---

## 3. Швидкий старт

Усі команди запускаються з кореня проєкту.

Зібрати повний інсталятор (спочатку NSIS, потім вікно):

```powershell
npm run dist:installer
```

Результат: `dist\DevBridge-Installer-1.1.0.exe`. Користувачам віддавайте **саме його**. `DevBridge-Setup-1.1.0.exe` лежить усередині, окремо роздавати його не треба.

Швидко зібрати тільки вікно (кілька секунд, для роботи над дизайном):

```powershell
npm run installer:preview
```

Подивитися наживо, нічого не встановлюючи:

```powershell
.\dist\DevBridge-Installer-preview.exe --demo
```

Подивитися екран помилки:

```powershell
.\dist\DevBridge-Installer-preview.exe --demo-error
```

Зберегти PNG усіх екранів:

```powershell
Start-Process .\dist\DevBridge-Installer-preview.exe -ArgumentList '--screenshots', 'dist\shots' -Wait
```

> ⚠️ `preview.exe` **без** `--demo` після кнопки «Встановити» покаже помилку, бо програми всередині нього немає. А повний інсталятор без `--demo` **справді встановлює** програму.

`npm run dist:win` власного вікна не збирає: він робить лише стандартні NSIS та портативну версії.

---

## 4. Створення з нуля, крок за кроком

Тут показано мінімальний варіант. Його можна повторити в порожній теці, щоб зрозуміти принцип.

### Крок 1. Зберіть тихий NSIS-інсталятор

У `package.json`:

```json
"build": {
  "appId": "com.example.myapp",
  "win": { "target": "nsis" },
  "nsis": {
    "guid": "ВАШ-GUID",
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "artifactName": "MyApp-Setup-${version}.${ext}"
  }
}
```

**Про `guid`.** За ним Windows знаходить попередню версію.

- Для **нової** програми створіть його один раз і більше не змінюйте:
  ```powershell
  [guid]::NewGuid().ToString()
  ```
- Якщо програму **вже встановлювали** користувачі, візьміть чинний GUID, інакше замість оновлення з'явиться друга копія. На комп'ютері, де вона встановлена (замініть `MyApp`):
  ```powershell
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object DisplayName -like 'MyApp*' | Select-Object DisplayName, PSChildName
  ```

```powershell
npx electron-builder --win nsis --x64
```

### Крок 2. Намалюйте вікно

Створіть теку `my-installer` і в ній файл `ui.xaml`:

```xml
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Встановлення MyApp" Width="480" Height="280"
        WindowStyle="None" ResizeMode="NoResize" WindowStartupLocation="CenterScreen"
        Background="#10141F">
  <StackPanel VerticalAlignment="Center" Margin="40">
    <TextBlock x:Name="Status" Text="Встановити MyApp" Foreground="#E4E8F2" FontSize="22" TextAlignment="Center"/>
    <Button x:Name="InstallButton" Content="Встановити" Height="40" Margin="0,24,0,0"
            Background="#FF9F43" BorderThickness="0"/>
    <Button x:Name="CloseButton" Content="Закрити" Height="32" Margin="0,8,0,0"/>
  </StackPanel>
</Window>
```

`WindowStyle="None"` прибирає стандартну рамку Windows. Саме це дозволяє зробити повністю свій вигляд, але кнопку закриття тепер треба додати самому.

У цьому файлі **не пишіть `x:Class` і `Click="..."`**: XAML читається під час запуску, а події підключаються в коді.

### Крок 3. Додайте логіку

Поруч створіть `Program.cs`:

```csharp
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;

static class Program
{
    [STAThread]
    static void Main()
    {
        Window window;
        using (var xaml = Resource("ui.xaml"))
            window = (Window)XamlReader.Load(xaml);

        var status = (TextBlock)window.FindName("Status");
        var install = (Button)window.FindName("InstallButton");
        var close = (Button)window.FindName("CloseButton");

        bool busy = false;
        close.Click += delegate { window.Close(); };
        window.Closing += delegate(object s, System.ComponentModel.CancelEventArgs e) { if (busy) e.Cancel = true; };

        install.Click += async delegate
        {
            busy = true;
            install.IsEnabled = false;
            status.Text = "Встановлюємо…";
            string target = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\MyApp");
            try
            {
                int code = await Task.Run(delegate { return Run(target); });
                status.Text = code == 0 ? "Готово" : "Помилка, код " + code;
            }
            catch (Exception error) { status.Text = error.Message; }
            busy = false;
        };

        new Application().Run(window);
    }

    static int Run(string target)
    {
        string folder = Path.Combine(Path.GetTempPath(), "MyAppSetup-" + Guid.NewGuid().ToString("N"));
        string setup = Path.Combine(folder, "setup.exe");
        Directory.CreateDirectory(folder);
        try
        {
            using (var source = Resource("payload.exe"))
            using (var file = File.Create(setup))
                source.CopyTo(file);

            var info = new ProcessStartInfo(setup, "/S /currentuser /D=" + target) { UseShellExecute = false };
            using (var process = Process.Start(info))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        finally { Directory.Delete(folder, true); }
    }

    static Stream Resource(string name)
    {
        return Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
    }
}
```

`Task.Run` потрібен, щоб вікно не «зависало», поки працює NSIS.

> У цьому прикладі тека задана в коді. **Щойно дозволите користувачеві її вибирати, обов'язково додайте перевірку з кроку 5.**

### Крок 4. Скомпілюйте

Скопіюйте у `my-installer` готовий NSIS-інсталятор і назвіть його `payload.exe`. Потім виконайте в цій теці в PowerShell:

```powershell
$fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
& "$fw\csc.exe" /nologo /target:winexe /platform:x64 /codepage:65001 /out:MyInstaller.exe "/r:$fw\WPF\PresentationFramework.dll" "/r:$fw\WPF\PresentationCore.dll" "/r:$fw\WPF\WindowsBase.dll" "/r:$fw\System.Xaml.dll" /resource:ui.xaml,ui.xaml /resource:payload.exe,payload.exe Program.cs
```

- `/resource:файл,ім'я` вкладає файл усередину exe.
- `/codepage:65001` читає код як UTF-8, без цього зламається кирилиця.
- Файли зберігайте в UTF-8.

Мінімальний інсталятор готовий. Решта кроків роблять його придатним для користувачів.

### Крок 5. Захистіть файли користувача ⚠️

Це **найважливіший крок**.

Деінсталятор NSIS видаляє теку встановлення **повністю** (`RMDir /r $INSTDIR`). У стандартному майстрі шаблон `electron-builder` сам додає до шляху підтеку програми. У тихому режимі (`/S`) цього не відбувається.

Приклад: користувач обрав `D:\Projects`, а ви передали цей шлях у `/D=` без змін. Під час видалення програми зникне **все** з `D:\Projects`.

Тому `InstallPath.cs`:

1. приймає тільки повний шлях на локальному диску;
2. відхиляє `"` та інші недозволені символи, щоб у командний рядок не потрапили зайві параметри;
3. завжди додає підтеку з назвою програми;
4. дозволяє вже наявну теку, лише якщо вона порожня або в ній уже стоїть ця програма;
5. перевіряє права на запис.

Перевірку виконуйте двічі: під час введення і ще раз перед самим запуском NSIS.

Наприклад, якщо на цьому комп'ютері обрати `D:\NORIS_PRIVATE_PROGRAMS`, вийде `...\DevBridge`, тобто тека самого проєкту (регістр літер Windows не враховує). Вона не порожня, тому встановлення блокується.

**Не прибирайте ці правила.**

### Крок 6. Доведіть до ладу

Це вже зроблено в повній версії, дивіться відповідні місця в `Installer.cs`:

| Що | Де шукати |
|---|---|
| тягання вікна за заголовок | `DragMove` |
| заборона закрити під час встановлення | `Window.Closing`, `busy` |
| пошук попередньої версії та кнопка «Оновити» | `FindPreviousInstall`, `ValidatePath` |
| попередження, що програма запущена | `IsAppRunning` |
| перевірка вільного місця | `Install`, `SpaceInfo` |
| захист від другої копії інсталятора | `Mutex` |
| демо-режим і знімки екранів | `--demo`, `SaveScreenshots` |

Попередження про запущену програму важливе: тихий NSIS закриває її **без запитань**.

---

## 5. Як змінювати дизайн

Майже все робиться в `ui.xaml`. Робочий цикл:

```powershell
npm run installer:preview; if ($?) { .\dist\DevBridge-Installer-preview.exe --demo }
```

Перед повторним збиранням закрийте вікно, інакше exe буде зайнятий.

### Кольори

Вони оголошені на початку файлу в `<Window.Resources>`:

```xml
<SolidColorBrush x:Key="Signal" Color="#FF9F43"/>
```

> Кілька кольорів записані ще й безпосередньо, бо їх потребують тригери, градієнти та тінь. Щоб змінити акцент повністю, знайдіть у файлі всі `FF9F43` (включно з `40FF9F43` і `00FF9F43`) та `FFB067` (колір кнопки під курсором). Кольори тексту `E4E8F2`, `8B93AB` і тла `1E2435` також повторюються в стилях.

Формат `#AARRGGBB`: перші дві цифри задають прозорість (`FF` непрозорий, `00` невидимий).

### Тексти

Постійні написи лежать в `ui.xaml` (`Text="..."`, `Content="..."`). Тексти, що змінюються (помилки, етапи, «Оновити»), у `Installer.cs` та `InstallPath.cs`.

### Розмір вікна

`Width="760" Height="620"` у тегу `<Window>`. З них по 20 px з кожного боку займає тінь (`Margin="20"` у `Root`). Після зміни перегляньте знімки всіх екранів, щоб нічого не обрізалося.

### Шрифт

`FontFamily` у тегу `<Window>` та в стилі `Heading`. Файли `.woff2` з програми WPF **не читає**. Для власного шрифту потрібні `.ttf` або `.otf`: вкладіть його через `/resource` та завантажте в коді. Простіше взяти системний.

### Картинка замість моста

Замініть увесь блок `<Viewbox Grid.Row="1">` на `<Image x:Name="Hero" .../>`. Але `Installer.cs` керує елементами `PacketMove` та `Packet`, тому:

- приберіть виклики `StartPacket()` і `StopPacket()` разом із цими методами;
- приберіть із `ShowPage` рядки про `PacketMove` і `Packet`;
- додайте картинку в `build.js` (`/resource:...,hero.png`) і завантажте її: `Get<Image>("Hero").Source = LoadImage("hero.png");`.

Якщо змінюєте тільки форму арки, оновіть однаковий шлях `M130,140 Q360,-40 590,140` у **двох місцях**: `Arc` в `ui.xaml` та `StartPacket` в `Installer.cs`. Інакше пакет летітиме повз міст. Підвіси, вузли та кінцеві координати в `ShowPage` теж треба підправити.

### Іконка та логотип

| Що | Файл |
|---|---|
| іконка exe-файлу | `build/icon.ico` |
| логотип у вікні та на панелі завдань | `src/assets/logo-64.png` |

---

## 6. Як додати нову опцію

Приклад: перемикач «Відкрити теку після встановлення».

**1. `ui.xaml`.** Три довгі перемикачі в один ряд не помістяться, тому додайте новий другим рядком, після `</StackPanel>` з перемикачами:

```xml
<CheckBox x:Name="OpenFolderSwitch" Style="{StaticResource Switch}"
          Content="Відкрити теку після встановлення" Margin="0,10,0,0"/>
```

Збільште `Height` вікна приблизно на 32.

**2. `Installer.cs`**, метод `Install()`. Прочитайте значення поруч з іншими перемикачами:

```csharp
bool openFolder = Get<CheckBox>("OpenFolderSwitch").IsChecked == true;
```

**3.** Виконайте дію після успішного встановлення, одразу після `installedTo = target;`:

```csharp
if (openFolder && !demo) Process.Start("explorer.exe", "\"" + target + "\"");
```

Так само додається будь-яка дія **після** встановлення. Якщо ж NSIS має робити щось **під час** встановлення чи видалення (наприклад, записати щось у реєстр), створіть `build/installer.nsh` з макросами `customInstall` та `customUnInstall`.

### Новий екран

1. Додайте в `ui.xaml` ще один `<Grid x:Name="LicensePage" Visibility="Collapsed">` поруч з іншими.
2. Допишіть `"LicensePage"` у список всередині `ShowPage`.
3. Підключіть кнопки: `OnClick("AcceptButton", delegate { ShowPage("WelcomePage"); });`.

---

## 7. Перевірка перед випуском

**Без змін у системі:**

- [ ] `npm run installer:preview` збирається без помилок.
- [ ] Знімки всіх екранів: нічого не обрізано й не накладається.
- [ ] `--demo` і `--demo-error` проходять до кінця.
- [ ] Під час прогресу вікно не закривається (хрестик і Alt+F4).
- [ ] Шлях до непорожньої чужої теки блокується.
- [ ] Керування з клавіатури: Tab, пробіл, Enter.
- [ ] Масштаб екрана 100% і 150%.

**Справжнє встановлення** найкраще перевіряти в **Windows Sandbox**: це чиста тимчасова Windows, яка після закриття все забуває. Вона є в редакціях Pro та Enterprise. Увімкніть «Пісочницю Windows» у «Компоненти Windows», перезавантажтесь і скопіюйте туди інсталятор.

- [ ] Чисте встановлення, програма запускається.
- [ ] Тека з пробілами та кирилицею в назві.
- [ ] Без ярлика на робочому столі.
- [ ] Оновлення поверх старої версії, коли вона запущена.
- [ ] Налаштування користувача після оновлення збереглися.
- [ ] Видалення через «Параметри → Програми» прибирає тільки теку програми.

**Новий випуск:** змініть `version` у `package.json` і виконайте `npm run dist:installer`. Версія, назви файлів і потрібне місце підставляться самі.

---

## 8. Перенесення в інший проєкт

1. Скопіюйте теку `installer/`.
2. Додайте в `package.json`:
   ```json
   "dist:installer": "electron-builder --win nsis --x64 && node installer/build.js",
   "installer:preview": "node installer/build.js --preview"
   ```
3. Задайте `build.nsis.guid` (крок 1) і `perMachine: false`.
4. Замініть усе, що прив'язане до DevBridge:

| Файл | Що замінити |
|---|---|
| `InstallPath.cs` | `AppFolder`, `ExeName` |
| `Installer.cs` | `"DevBridge"` в `IsAppRunning` та тексти повідомлень |
| `build.js` | назва в `AssemblyTitle` і `AssemblyProduct`, назви файлів `DevBridge-...`, шлях до логотипа |
| `ui.xaml` | заголовки, опис, підписи вузлів, міст і кольори |
| `app.manifest` | `name="DevBridgeSetup"` |

Щоб нічого не пропустити:

```powershell
Select-String -Path installer\*.cs, installer\*.js, installer\*.xaml, installer\*.manifest -Pattern 'DevBridge'
```

`AppFolder` та `ExeName` мають збігатися з тим, що створює `electron-builder` (`productName`, `win.executableName`). Простір імен `DevBridgeSetup` можна залишити. Якщо перейменовуєте, то в усіх `.cs` та в `build.js` одночасно.

`InstallPath.cs` впізнає наявну програму за `ExeName` та `resources\app.asar`. Якщо у вас вимкнений `asar`, змініть цю умову.

Для програм **не** на Electron принцип той самий: потрібен будь-який інсталятор з тихим режимом. Але параметри командного рядка та поведінка деінсталятора будуть іншими, тому спочатку перевірте їх у його документації.

---

## 9. Типові помилки

| Проблема | Причина та рішення |
|---|---|
| `error CS1056: Unexpected character '$'` | синтаксис новіший за C# 5 (див. розділ 2) |
| замість кирилиці незрозумілі символи | файл не в UTF-8 або немає `/codepage:65001` |
| `error CS0016: Could not write to output file` | інсталятор ще запущений, закрийте його |
| нічого не відбувається під час запуску | помилка в XAML виявляється лише під час запуску; запустіть команду нижче |
| `У ui.xaml немає елемента ...` | перейменували або видалили `x:Name`, який шукає код |
| `У exe немає вбудованого файлу payload.exe` | натиснули «Встановити» у preview-збірці без `--demo` |
| програма встановилась не туди | `/D=` не останній або в лапках |
| після оновлення дві копії в «Програмах» | змінився `guid` |
| `немає dist\...Setup...exe` | запускайте `npm run dist:installer`, а не лише `build.js` |
| знімки не з'явилися одразу | це віконна програма, тому потрібен `Start-Process ... -Wait` |

Подивитися причину, якщо вікно не відкривається:

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='.NET Runtime'} -MaxEvents 3 | Format-List TimeCreated, Message
```

---

## 10. Обмеження

- **Відсотків прогресу немає.** Тихий NSIS їх не повідомляє, тому смуга лише показує, що робота триває. Не малюйте вигадані відсотки.
- **Скасувати встановлення не можна** після запуску NSIS: переривання залишило б програму наполовину встановленою.
- **Деінсталятор залишається стандартним NSIS.**
- **Тільки встановлення для поточного користувача.** Для всіх користувачів потрібні підвищення прав і інші перевірки шляху.
- **Тільки темна тема.** Для світлої треба винести кольори у два набори.
- **Тільки Windows.** Збірки для macOS і Linux не змінюються.
- **SmartScreen.** Власний дизайн не прибирає попередження. Для цього файл треба підписати сертифікатом підпису коду, і навіть тоді репутація може накопичуватися поступово. Якщо підписуєте, підпишіть і вкладений NSIS (це вміє `electron-builder`), і готову оболонку (`signtool`).
- **Автооновлення.** Якщо колись додасте `electron-updater`, йому для оновлень потрібен саме NSIS-файл, а не ваша оболонка.
