// Правила для теки встановлення.
//
// УВАГА: це захист від втрати файлів. Деінсталятор NSIS видаляє теку встановлення
// повністю (RMDir /r $INSTDIR). У звичайному майстрі до шляху сам додається підтека
// з назвою програми, але в тихому режимі (/S) цього не відбувається.
// Тому тут ми самі гарантуємо, що програма отримає окрему, порожню теку.
using System;
using System.IO;

namespace DevBridgeSetup
{
    public sealed class PathCheck
    {
        public string Target;     // остаточна тека (null, якщо шлях неправильний)
        public string Error;      // чому встановлювати не можна (null, якщо можна)
        public bool IsUpgrade;    // у теці вже лежить DevBridge
    }

    public static class InstallPath
    {
        public const string AppFolder = "DevBridge";
        public const string ExeName = "DevBridge.exe";

        public static PathCheck Check(string input)
        {
            string raw = (input ?? "").Trim();
            if (raw.Length == 0) return Fail("Вкажіть теку встановлення.");

            if (raw.IndexOfAny(new[] { '"', '<', '>', '|', '*', '?' }) >= 0 || raw.IndexOfAny(Path.GetInvalidPathChars()) >= 0)
                return Fail("У шляху є недозволені символи.");

            // потрібен повний шлях на локальному диску: C:\...
            if (raw.Length < 3 || !char.IsLetter(raw[0]) || raw[1] != ':' || (raw[2] != '\\' && raw[2] != '/'))
                return Fail("Вкажіть повний шлях на локальному диску, наприклад C:\\Apps.");

            if (raw.IndexOf(':', 2) >= 0) return Fail("У шляху є недозволені символи.");

            string full;
            try { full = Path.GetFullPath(raw).TrimEnd('\\'); }
            catch (Exception) { return Fail("Такий шлях використати не можна."); }

            if (!string.Equals(Path.GetFileName(full), AppFolder, StringComparison.OrdinalIgnoreCase))
                full = full + "\\" + AppFolder;

            if (full.Length > 180) return Fail("Шлях задовгий. Оберіть теку ближче до кореня диска.");
            if (File.Exists(full)) return Fail("За цим шляхом уже є файл.");

            var result = new PathCheck { Target = full };

            if (Directory.Exists(full))
            {
                try
                {
                    result.IsUpgrade = File.Exists(Path.Combine(full, ExeName))
                        && File.Exists(Path.Combine(full, "resources\\app.asar"));

                    if (!result.IsUpgrade)
                    {
                        using (var entries = Directory.EnumerateFileSystemEntries(full).GetEnumerator())
                        {
                            if (entries.MoveNext())
                                result.Error = "Тека " + full + " не порожня. Під час видалення її буде стерто повністю, тому оберіть іншу.";
                        }
                    }
                }
                catch (Exception)
                {
                    result.Error = "Немає доступу до цієї теки.";
                }
            }

            if (result.Error == null && !CanWrite(full))
                result.Error = "Немає прав на запис. Оберіть теку у своєму профілі або на іншому диску.";

            return result;
        }

        // Пробуємо створити тимчасовий файл у найближчій теці, яка вже існує.
        static bool CanWrite(string target)
        {
            try
            {
                string dir = target;
                while (dir != null && !Directory.Exists(dir)) dir = Path.GetDirectoryName(dir);
                if (dir == null) return false;
                string probe = Path.Combine(dir, ".devbridge-" + Guid.NewGuid().ToString("N") + ".tmp");
                using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) { }
                return true;
            }
            catch (Exception) { return false; }
        }

        static PathCheck Fail(string message)
        {
            return new PathCheck { Error = message };
        }
    }
}
