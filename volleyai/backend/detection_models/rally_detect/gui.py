import tkinter as tk
import customtkinter as ctk

def show_splash():
    # 1. Create a lightweight splash window
    splash = tk.Tk()
    splash.title("Loading Volleyball Analytics...")
    
    # Center the splash screen
    width, height = 400, 200
    x = (splash.winfo_screenwidth() // 2) - (width // 2)
    y = (splash.winfo_screenheight() // 2) - (height // 2)
    splash.geometry(f"{width}x{height}+{x}+{y}")
    
    # Remove borders
    splash.overrideredirect(True)
    splash.configure(bg="#1f538d")

    # Add a loading message
    label = tk.Label(splash, text="Volleyball Playtime Extractor\nLoading Pipeline...", 
                     fg="white", bg="#1f538d", font=("Roboto", 16, "bold"))
    label.pack(expand=True)
    
    # Force the splash window to show before moving to imports
    splash.update()
    return splash

if __name__ == "__main__":
    # Show splash immediately
    splash_window = show_splash()

    # Now do the heavy imports while splash is visible
    from src.gui.app import VolleyballAnalyticsGUI
    
    # Initialize the main app
    app = VolleyballAnalyticsGUI()
    
    # Set a timer to close splash and show main app
    def transition():
        splash_window.destroy()

    # Adjust the delay (ms) based on your needs
    splash_window.after(1000, transition)
    app.mainloop()