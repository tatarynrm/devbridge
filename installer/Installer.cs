// Власна оболонка інсталятора DevBridge.
//
// Вікно малюємо самі (ui.xaml), а файли, реєстр, ярлики й деінсталятор
// робить звичайний NSIS-інсталятор, вбудований всередину цього exe.
// Його ми запускаємо тихо:  setup.exe /S /currentuser [--no-desktop-shortcut] /D=<тека>
//
// Увага: компілятор csc.exe з Windows розуміє лише C# 5
// (без $"...", ?. та nameof).
//
// Ключі для розробки:
//   --demo                встановлення тільки імітується, система не змінюється
//   --demo-error          те саме, але закінчується помилкою
//   --screenshots <тека>  зберегти PNG кожного екрана й вийти
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace DevBridgeSetup
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            bool demoError = Array.IndexOf(args, "--demo-error") >= 0;
            bool demo = demoError || Array.IndexOf(args, "--demo") >= 0;
            int shots = Array.IndexOf(args, "--screenshots");

            if (shots >= 0)
            {
                if (shots + 1 >= args.Length) return 2;
                new InstallerWindow(true, false).SaveScreenshots(args[shots + 1]);
                return 0;
            }

            bool first;
            using (var mutex = new Mutex(true, "Local\\DevBridgeSetupShell", out first))
            {
                if (!first)
                {
                    MessageBox.Show("Інсталятор DevBridge уже відкритий.", "DevBridge");
                    return 1;
                }
                new Application().Run(new InstallerWindow(demo, demoError).Window);
                GC.KeepAlive(mutex);
            }
            return 0;
        }
    }

    sealed class InstallerWindow
    {
        // Значення підставляє build.js під час збирання.
        static readonly string Version = BuildInfo.Version;
        static readonly string AppGuid = BuildInfo.AppGuid;
        static readonly long RequiredBytes = BuildInfo.RequiredBytes;

        public readonly Window Window;
        readonly bool demo;
        readonly bool demoError;
        bool busy;
        string installedTo;

        public InstallerWindow(bool demo, bool demoError)
        {
            this.demo = demo;
            this.demoError = demoError;

            using (var xaml = Resource("ui.xaml"))
                Window = (Window)XamlReader.Load(xaml);

            var logo = LoadImage("logo.png");
            Get<Image>("Logo").Source = logo;
            Window.Icon = logo;
            Get<TextBlock>("VersionText").Text = Version + (demo ? "  ·  демо-режим" : "");

            Get<FrameworkElement>("TitleBar").MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed) Window.DragMove();
            };
            OnClick("MinButton", delegate { Window.WindowState = WindowState.Minimized; });
            OnClick("CloseButton", delegate { Window.Close(); });
            OnClick("DoneCloseButton", delegate { Window.Close(); });
            OnClick("ErrorCloseButton", delegate { Window.Close(); });
            OnClick("BrowseButton", delegate { Browse(); });
            OnClick("InstallButton", delegate { Install(); });
            OnClick("RetryButton", delegate { ShowPage("WelcomePage"); ValidatePath(); });
            OnClick("LaunchButton", delegate { Launch(); Window.Close(); });

            // поки йде встановлення, вікно закривати не можна
            Window.Closing += delegate(object s, System.ComponentModel.CancelEventArgs e) { if (busy) e.Cancel = true; };

            string previous = FindPreviousInstall();
            var input = Get<TextBox>("PathInput");
            input.Text = previous ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", InstallPath.AppFolder);
            input.TextChanged += delegate { ValidatePath(); };
            input.GotKeyboardFocus += delegate { Get<Border>("PathBox").BorderBrush = ThemeBrush("Signal"); };
            input.LostKeyboardFocus += delegate { Get<Border>("PathBox").BorderBrush = ThemeBrush("Line"); ShowResolvedPath(); };

            ValidatePath();
        }

        /* ---------- екран налаштувань ---------- */

        PathCheck ValidatePath()
        {
            var check = InstallPath.Check(Get<TextBox>("PathInput").Text);
            var hint = Get<TextBlock>("PathHint");
            var button = Get<Button>("InstallButton");

            if (check.Error != null)
            {
                hint.Text = check.Error;
                hint.Foreground = ThemeBrush("Fail");
            }
            else if (IsAppRunning())
            {
                hint.Text = "DevBridge зараз запущений. Під час встановлення його буде закрито, а тунелі зупиняться.";
                hint.Foreground = ThemeBrush("Warn");
            }
            else
            {
                hint.Text = "Буде встановлено в " + check.Target;
                hint.Foreground = ThemeBrush("Muted");
            }

            button.IsEnabled = check.Error == null;
            button.Content = check.IsUpgrade ? "Оновити" : "Встановити";
            Get<TextBlock>("WelcomeTitle").Text = check.IsUpgrade ? "Оновити DevBridge" : "Встановити DevBridge";
            Get<TextBlock>("SpaceText").Text = SpaceInfo(check.Target);
            return check;
        }

        // Після редагування показуємо в полі саме ту теку, куди піде програма.
        void ShowResolvedPath()
        {
            var check = InstallPath.Check(Get<TextBox>("PathInput").Text);
            if (check.Target != null) Get<TextBox>("PathInput").Text = check.Target;
        }

        static string SpaceInfo(string target)
        {
            string need = RequiredBytes > 0 ? "Потрібно " + Megabytes(RequiredBytes) : "";
            if (target == null) return need;
            try
            {
                long free = new DriveInfo(target.Substring(0, 1)).AvailableFreeSpace;
                return (need.Length > 0 ? need + "  ·  " : "") + "вільно " + Megabytes(free);
            }
            catch (Exception) { return need; }
        }

        static string Megabytes(long bytes)
        {
            double mb = bytes / 1048576.0;
            return mb >= 1024 ? (mb / 1024).ToString("0.#") + " ГБ" : mb.ToString("0") + " МБ";
        }

        void Browse()
        {
            string start = Get<TextBox>("PathInput").Text.Trim();
            try
            {
                while (!string.IsNullOrEmpty(start) && !Directory.Exists(start)) start = Path.GetDirectoryName(start);
            }
            catch (Exception) { start = null; }

            string picked = FolderPicker.Pick(new WindowInteropHelper(Window).Handle, "Куди встановити DevBridge", start);
            if (picked == null) return;
            Get<TextBox>("PathInput").Text = picked;
            ShowResolvedPath();
        }

        /* ---------- встановлення ---------- */

        async void Install()
        {
            if (busy) return;
            // перевіряємо ще раз: вміст теки міг змінитися, поки вікно було відкрите
            var check = ValidatePath();
            if (check.Error != null) return;

            bool desktop = Get<CheckBox>("DesktopSwitch").IsChecked == true;
            bool launch = Get<CheckBox>("LaunchSwitch").IsChecked == true;
            string target = check.Target;

            long free;
            try { free = new DriveInfo(target.Substring(0, 1)).AvailableFreeSpace; }
            catch (Exception) { free = long.MaxValue; }
            if (free < RequiredBytes)
            {
                ShowError("На диску замало місця. Потрібно " + Megabytes(RequiredBytes) + ".");
                return;
            }

            busy = true;
            Get<Button>("CloseButton").IsEnabled = false;
            ShowPage("ProgressPage");
            StartPacket();

            try
            {
                var stage = Get<TextBlock>("StageText");
                if (demo)
                {
                    stage.Text = "Готуємо файли…";
                    await Task.Delay(1200);
                    stage.Text = "Копіюємо DevBridge у " + target;
                    await Task.Delay(2600);
                    if (demoError) throw new InvalidOperationException("Це приклад помилки в демо-режимі.");
                }
                else
                {
                    stage.Text = "Готуємо файли…";
                    string folder = Path.Combine(Path.GetTempPath(), "DevBridgeSetup-" + Guid.NewGuid().ToString("N"));
                    string setup = Path.Combine(folder, "setup.exe");
                    try
                    {
                        await Task.Run(delegate { ExtractPayload(folder, setup); });
                        stage.Text = "Копіюємо DevBridge у " + target;
                        int code = await Task.Run(delegate { return RunSetup(setup, target, desktop); });
                        if (code != 0)
                            throw new InvalidOperationException("Інсталятор завершився з кодом " + code + ". Закрийте DevBridge та спробуйте ще раз.");
                        if (!File.Exists(Path.Combine(target, InstallPath.ExeName)))
                            throw new InvalidOperationException("Після встановлення не знайдено " + InstallPath.ExeName + ". Перевірте, чи не заблокував файли антивірус.");
                    }
                    finally
                    {
                        TryDelete(folder);
                    }
                }

                busy = false;
                installedTo = target;
                StopPacket();
                Get<TextBlock>("DoneText").Text = "DevBridge " + Version + " встановлено в\n" + target;
                if (launch)
                {
                    Launch();
                    Window.Close();
                    return;
                }
                ShowPage("DonePage");
            }
            catch (Exception error)
            {
                busy = false;
                StopPacket();
                ShowError(error.Message);
            }
            finally
            {
                busy = false;
                Get<Button>("CloseButton").IsEnabled = true;
            }
        }

        static void ExtractPayload(string folder, string setup)
        {
            Directory.CreateDirectory(folder);
            using (var source = Resource("payload.exe"))
            using (var file = new FileStream(setup, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                source.CopyTo(file);
        }

        static int RunSetup(string setup, string target, bool desktopShortcut)
        {
            // /D= обов'язково останній і без лапок, навіть якщо в шляху є пробіли
            string arguments = "/S /currentuser"
                + (desktopShortcut ? "" : " --no-desktop-shortcut")
                + " /D=" + target;

            var info = new ProcessStartInfo(setup, arguments) { UseShellExecute = false, CreateNoWindow = true };
            using (var process = Process.Start(info))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }

        static void TryDelete(string folder)
        {
            try { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
            catch (Exception) { /* тимчасові файли Windows прибере сама */ }
        }

        void Launch()
        {
            if (demo || installedTo == null) return;
            try
            {
                var info = new ProcessStartInfo(Path.Combine(installedTo, InstallPath.ExeName));
                info.WorkingDirectory = installedTo;
                Process.Start(info);
            }
            catch (Exception error)
            {
                MessageBox.Show("DevBridge встановлено, але запустити не вдалося:\n" + error.Message, "DevBridge");
            }
        }

        static string FindPreviousInstall()
        {
            using (var key = Registry.CurrentUser.OpenSubKey("Software\\" + AppGuid))
            {
                var location = key == null ? null : key.GetValue("InstallLocation") as string;
                return !string.IsNullOrEmpty(location) && Directory.Exists(location) ? location : null;
            }
        }

        static bool IsAppRunning()
        {
            var found = Process.GetProcessesByName("DevBridge");
            foreach (var process in found) process.Dispose();
            return found.Length > 0;
        }

        /* ---------- анімація та екрани ---------- */

        void StartPacket()
        {
            if (!SystemParameters.ClientAreaAnimation) return;   // анімації вимкнені в Windows
            var path = new PathGeometry();
            path.AddGeometry(Geometry.Parse("M130,140 Q360,-40 590,140"));
            var move = (TranslateTransform)Window.FindName("PacketMove");
            move.BeginAnimation(TranslateTransform.XProperty, Along(path, PathAnimationSource.X));
            move.BeginAnimation(TranslateTransform.YProperty, Along(path, PathAnimationSource.Y));
        }

        static DoubleAnimationUsingPath Along(PathGeometry path, PathAnimationSource source)
        {
            return new DoubleAnimationUsingPath
            {
                PathGeometry = path,
                Source = source,
                Duration = TimeSpan.FromSeconds(1.6),
                RepeatBehavior = RepeatBehavior.Forever
            };
        }

        void StopPacket()
        {
            var move = (TranslateTransform)Window.FindName("PacketMove");
            move.BeginAnimation(TranslateTransform.XProperty, null);
            move.BeginAnimation(TranslateTransform.YProperty, null);
        }

        void ShowPage(string name)
        {
            foreach (var page in new[] { "WelcomePage", "ProgressPage", "DonePage", "ErrorPage" })
                Get<FrameworkElement>(page).Visibility = page == name ? Visibility.Visible : Visibility.Collapsed;

            // пакет "доїхав" на фініші, а при помилці його не видно
            var move = (TranslateTransform)Window.FindName("PacketMove");
            if (name == "DonePage") { move.X = 590; move.Y = 140; }
            else if (name == "WelcomePage") { move.X = 429; move.Y = 58; }
            Get<FrameworkElement>("Packet").Visibility = name == "ErrorPage" ? Visibility.Hidden : Visibility.Visible;

            // Enter натискає головну кнопку поточного екрана
            Get<Button>("InstallButton").IsDefault = name == "WelcomePage";
            Get<Button>("LaunchButton").IsDefault = name == "DonePage";
            Get<Button>("RetryButton").IsDefault = name == "ErrorPage";
        }

        void ShowError(string message)
        {
            Get<TextBlock>("ErrorText").Text = message;
            ShowPage("ErrorPage");
        }

        /* ---------- знімки екранів для перевірки дизайну ---------- */

        public void SaveScreenshots(string folder)
        {
            Directory.CreateDirectory(folder);
            Shot(folder, "1-welcome.png");

            Get<TextBox>("PathInput").Text = "relative\\path";
            Shot(folder, "2-path-error.png");

            ShowPage("ProgressPage");
            Get<TextBlock>("StageText").Text = "Копіюємо DevBridge у C:\\Users\\you\\AppData\\Local\\Programs\\DevBridge";
            Shot(folder, "3-progress.png");

            Get<TextBlock>("DoneText").Text = "DevBridge " + Version + " встановлено в\nC:\\Users\\you\\AppData\\Local\\Programs\\DevBridge";
            ShowPage("DonePage");
            Shot(folder, "4-done.png");

            ShowError("Інсталятор завершився з кодом 2. Закрийте DevBridge та спробуйте ще раз.");
            Shot(folder, "5-error.png");
        }

        void Shot(string folder, string name)
        {
            // малюємо вміст вікна, не показуючи саме вікно
            var content = (FrameworkElement)Window.Content;
            var size = new Size(Window.Width, Window.Height);
            content.Measure(size);
            content.Arrange(new Rect(size));
            content.UpdateLayout();
            Window.Dispatcher.Invoke(new Action(delegate { }), System.Windows.Threading.DispatcherPriority.ContextIdle);

            const double scale = 1.5;
            var bitmap = new RenderTargetBitmap((int)(size.Width * scale), (int)(size.Height * scale), 96 * scale, 96 * scale, PixelFormats.Pbgra32);

            // окремий шар, щоб зберегти Margin навколо вмісту (там тінь)
            var visual = new DrawingVisual();
            using (var context = visual.RenderOpen())
                context.DrawRectangle(new SolidColorBrush(Color.FromRgb(0x3A, 0x40, 0x4E)), null, new Rect(size));
            bitmap.Render(visual);
            bitmap.Render(content);

            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using (var file = File.Create(Path.Combine(folder, name)))
                encoder.Save(file);
        }

        /* ---------- дрібниці ---------- */

        T Get<T>(string name) where T : class
        {
            var element = Window.FindName(name) as T;
            if (element == null) throw new InvalidOperationException("У ui.xaml немає елемента " + name);
            return element;
        }

        void OnClick(string name, Action action)
        {
            Get<Button>(name).Click += delegate { action(); };
        }

        Brush ThemeBrush(string key)
        {
            return (Brush)Window.FindResource(key);
        }

        static Stream Resource(string name)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (stream == null) throw new InvalidOperationException("У exe немає вбудованого файлу " + name + ". Зберіть інсталятор без ключа --preview.");
            return stream;
        }

        static BitmapImage LoadImage(string name)
        {
            using (var stream = Resource(name))
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.StreamSource = stream;
                image.EndInit();
                return image;
            }
        }
    }
}
