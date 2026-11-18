using System;
using System.Runtime.InteropServices;
using System.Text;

/** 给 Tauri 窗口发键盘（按前台窗口发，先 SetForegroundWindow 再 keybd_event） */
public static class Keys
{
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public static bool Focus(IntPtr h)
    {
        ShowWindow(h, 9);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(250);
        return GetForegroundWindow() == h;
    }

    public static void Space()
    {
        keybd_event(0x20, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        keybd_event(0x20, 0, 2, UIntPtr.Zero);
    }
}
