using System;
using System.Runtime.InteropServices;
using System.Text;

/** 极简 UI 探针：找窗口 → 按客户区坐标点击（截图交给 PowerShell 做）。只用于本机自测。 */
public static class UiProbe
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);

    /** 把窗口顶到最前（SetForegroundWindow 常被系统拒绝，用 TOPMOST 绕一下最稳） */
    public static void Raise(IntPtr h)
    {
        ShowWindow(h, 9); // SW_RESTORE
        SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002); // HWND_TOPMOST, NOSIZE|NOMOVE
        SetForegroundWindow(h);
        SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002); // HWND_NOTOPMOST
    }

    /** 诊断：屏幕坐标 (x,y) 处到底是哪个窗口 */
    public static string Probe(int x, int y)
    {
        var p = new POINT { X = x, Y = y };
        IntPtr at = WindowFromPoint(p);
        IntPtr fg = GetForegroundWindow();
        var c = new StringBuilder(128); GetClassName(at, c, 128);
        return "point=0x" + at.ToInt64().ToString("x") + " class=" + c + " fg=0x" + fg.ToInt64().ToString("x");
    }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, int d, IntPtr e);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;

    public static IntPtr FindMain(uint target)
    {
        IntPtr found = IntPtr.Zero; int best = 0;
        EnumWindows((h, l) =>
        {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == target)
            {
                var c = new StringBuilder(128); GetClassName(h, c, 128);
                if (c.ToString() == "Tauri Window")
                {
                    RECT r; GetWindowRect(h, out r);
                    int a = (r.R - r.L) * (r.B - r.T);
                    if (a > best) { best = a; found = h; }
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /** 在窗口客户区坐标 (cx, cy) 点一下 */
    public static void Click(IntPtr h, int cx, int cy)
    {
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(250);
        var p = new POINT { X = cx, Y = cy };
        ClientToScreen(h, ref p);
        SetCursorPos(p.X, p.Y);
        System.Threading.Thread.Sleep(120);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(500);
    }

    /** 按住从 (x1,y1) 拖到 (x2,y2) */
    public static void Drag(IntPtr h, int x1, int y1, int x2, int y2)
    {
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(250);
        var p = new POINT { X = x1, Y = y1 };
        ClientToScreen(h, ref p);
        SetCursorPos(p.X, p.Y);
        System.Threading.Thread.Sleep(120);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(120);
        var q = new POINT { X = x2, Y = y2 };
        ClientToScreen(h, ref q);
        for (int i = 1; i <= 8; i++)
        {
            SetCursorPos(p.X + (q.X - p.X) * i / 8, p.Y + (q.Y - p.Y) * i / 8);
            System.Threading.Thread.Sleep(60);
        }
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(400);
    }
}
