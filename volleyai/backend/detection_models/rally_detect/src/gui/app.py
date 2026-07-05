# src/gui/app.py

import os
import threading
import customtkinter as ctk
from tkinter import messagebox
from src.pipeline.manager import run_volleyball_pipeline
from src.gui.components import FilePicker, AdvancedOptionsFrame
from src.utils import get_resource_path

class VolleyballAnalyticsGUI(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Volleyball Playtime Extractor")
        self.geometry("850x900")
        ctk.set_appearance_mode("dark")
        
        # State Variables
        self.video_path = ctk.StringVar(self)
        self.output_dir = ctk.StringVar(self, value=os.path.join(os.path.expanduser("~"), "Videos", "volleyball"))
        self.device = ctk.StringVar(self, value="intel:gpu")
        self.rf_model_ver = ctk.StringVar(self, value="v3")
        self.start_at = ctk.StringVar(self, value="detection")
        self.stop_at = ctk.StringVar(self, value="visualization")
        self.viz_type = ctk.StringVar(self, value="cut")
        self.keep_all = ctk.BooleanVar(self, value=False)
        self.start_time = ctk.StringVar(self, value="00:00:00")
        self.end_time = ctk.StringVar(self, value="00:00:00")
        self.input_csv_path = ctk.StringVar(self, value="")
        self.viz_early = ctk.BooleanVar(self, value=False)
        
        self.show_advanced = False
        
        self.setup_ui()

    def setup_ui(self):
        # Title
        self.label = ctk.CTkLabel(self, text="Volleyball Playtime Extractor", font=("Roboto", 24, "bold"))
        self.label.pack(pady=20)

        #Icon
        icon_path = get_resource_path(os.path.join("assets", "volleyball_app.ico"))
        self.iconbitmap(icon_path)

        # File Selection Section
        self.video_picker = FilePicker(self, "Input Video:", self.video_path, mode="file")
        self.video_picker.pack(pady=5, padx=20, fill="x")

        self.output_picker = FilePicker(self, "Output Folder:", self.output_dir, mode="folder")
        self.output_picker.pack(pady=5, padx=20, fill="x")

        # Add Progress Bar
        self.progress_bar = ctk.CTkProgressBar(self)
        self.progress_bar.pack(pady=(10, 0), padx=20, fill="x")
        self.progress_bar.set(0)
        
        self.progress_label = ctk.CTkLabel(self, text="Status: Idle", font=("Roboto", 12))
        self.progress_label.pack(pady=(0, 10))

        # --- Advanced Options Toggle ---
        self.adv_toggle_btn = ctk.CTkButton(self, text="▶ Advanced Options", fg_color="transparent", 
                                            text_color=("gray10", "gray90"), anchor="w", 
                                            command=self.toggle_advanced)
        self.adv_toggle_btn.pack(pady=(5, 0), padx=20, fill="x")

        # Pass EVERYTHING to the advanced frame now
        adv_vars = {
            'rf_model_ver': self.rf_model_ver,
            'device': self.device,
            'start_at': self.start_at,       
            'stop_at': self.stop_at,
            'input_csv_path': self.input_csv_path, 
            'viz_early': self.viz_early,     
            'keep_all': self.keep_all,
            'viz_type': self.viz_type,
            'start_time': self.start_time,
            'end_time': self.end_time
        }
        self.adv_frame = AdvancedOptionsFrame(self, adv_vars)

        # Logging Box
        self.log_text = ctk.CTkTextbox(self, height=0)
        self.log_text.pack(pady=20, padx=20, fill="both", expand=True)
        self.log_text.configure(state="disabled")

        # Execution Button
        self.run_button = ctk.CTkButton(self, text="Start Pipeline", command=self.start_pipeline_thread, 
                                        fg_color="#1f538d", hover_color="#14375e", height=40, font=("Roboto", 16, "bold"))
        self.run_button.pack(pady=20)

        
    def toggle_advanced(self):
        if self.show_advanced:
            self.adv_frame.pack_forget()
            self.adv_toggle_btn.configure(text="▶ Advanced Options")
        else:
            self.adv_frame.pack(pady=5, padx=20, fill="x", before=self.log_text)
            self.adv_toggle_btn.configure(text="▼ Advanced Options")
        self.show_advanced = not self.show_advanced

    def log(self, message):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", message + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def start_pipeline_thread(self):
        if not self.video_path.get():
            messagebox.showerror("Error", "Please select a video file.")
            return
        
        config = {
            'video_path': self.video_path.get(),
            'output_dir': self.output_dir.get(),
            'device': self.device.get(),
            'rf_model_ver': self.rf_model_ver.get(),
            'start_at': self.start_at.get(),
            'stop_at': self.stop_at.get(),
            'input_csv_path': self.input_csv_path.get(),
            'viz_early': self.viz_early.get(),         
            'viz_type': self.viz_type.get(),
            'keep_all': self.keep_all.get(),
            'start_time': self.start_time.get(),
            'end_time': self.end_time.get()
        }

        self.run_button.configure(state="disabled", text="Processing...")
        thread = threading.Thread(target=self.execute_run, args=(config,))
        thread.daemon = True
        thread.start()

    def update_gui_progress(self, current, total, description):
        """Thread-safe update for the GUI progress bar."""
        percent = current / total
        # Use .after to ensure UI updates happen on the main thread
        self.after(0, lambda: self.progress_bar.set(percent))
        self.after(0, lambda: self.progress_label.configure(text=f"{description}: {int(percent*100)}%"))

    def execute_run(self, config):
        try:
            success, output_path = run_volleyball_pipeline(config, self.log, self.update_gui_progress)
            if success:
                self.log("Pipeline Finished Successfully!")
                messagebox.showinfo("Success", f"Pipeline complete!\nSaved to: {output_path}")
        except Exception as e:
            self.log(f"ERROR: {str(e)}")
            messagebox.showerror("Pipeline Error", str(e))
        finally:
            self.run_button.configure(state="normal", text="Start Pipeline")