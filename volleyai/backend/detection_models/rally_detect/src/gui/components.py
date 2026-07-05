# src/gui/components.py

import customtkinter as ctk
from tkinter import filedialog

class FilePicker(ctk.CTkFrame):
    """A reusable row for picking a file or directory."""
    def __init__(self, master, label_text, variable, mode="file", **kwargs):
        super().__init__(master, fg_color="transparent", **kwargs)
        self.variable = variable
        self.mode = mode

        self.label = ctk.CTkLabel(self, text=label_text, width=120, anchor="w")
        self.label.pack(side="left", padx=(10, 5))

        self.entry = ctk.CTkEntry(self, textvariable=self.variable)
        self.entry.pack(side="left", padx=5, fill="x", expand=True)

        btn_text = "Browse" if mode == "file" else "Folder"
        self.button = ctk.CTkButton(self, text=btn_text, width=100, command=self.browse)
        self.button.pack(side="left", padx=(5, 10))

    def browse(self):
        if self.mode == "file":
            path = filedialog.askopenfilename(filetypes=[("Video files", "*.mp4 *.avi *.mov")])
        else:
            path = filedialog.askdirectory()
        
        if path:
            self.variable.set(path)

class AdvancedOptionsFrame(ctk.CTkFrame):
    def __init__(self, master, variables, **kwargs):
        super().__init__(master, **kwargs)
        self.grid_columnconfigure((1, 3), weight=1)

        # Configure columns so they expand evenly
        self.grid_columnconfigure((1, 3), weight=1)

        # --- Section 1: Pipeline Flow ---
        self.create_header("Pipeline Control", 0)

        stages = ["detection", "tracking", "cleaning", "features", "prediction", "visualization"]
        
        ctk.CTkLabel(self, text="Start At:").grid(row=1, column=0, padx=(20, 10), pady=5, sticky="w")
        ctk.CTkComboBox(self, values=stages, variable=variables['start_at']).grid(row=1, column=1, padx=10, pady=5, sticky="ew")
        
        ctk.CTkLabel(self, text="Stop At:").grid(row=1, column=2, padx=(20, 10), pady=5, sticky="w")
        ctk.CTkComboBox(self, values=stages, variable=variables['stop_at']).grid(row=1, column=3, padx=10, pady=5, sticky="ew")

        # --- Section 2: Input Overrides ---
        ctk.CTkLabel(self, text="Custom CSV:").grid(row=2, column=0, padx=(20, 10), pady=5, sticky="w")
        self.csv_entry = ctk.CTkEntry(self, textvariable=variables['input_csv_path'], placeholder_text="Path to .csv if skipping stages...")
        self.csv_entry.grid(row=2, column=1, columnspan=2, padx=10, pady=5, sticky="ew")
        ctk.CTkButton(self, text="Browse", width=80, command=self.browse_csv).grid(row=2, column=3, padx=(0, 20), pady=5, sticky="w")

        # --- Section 3: Model & Hardware ---
        self.create_header("Hardware & Model", 3)

        ctk.CTkLabel(self, text="RF Model:").grid(row=4, column=0, padx=(20, 10), pady=5, sticky="w")
        ctk.CTkComboBox(self, values=["v3", "v4"], variable=variables['rf_model_ver']).grid(row=4, column=1, padx=10, pady=5, sticky="ew")
        
        ctk.CTkLabel(self, text="Device:").grid(row=4, column=2, padx=(20, 10), pady=5, sticky="w")
        ctk.CTkComboBox(self, values=["cpu", "intel:gpu"], variable=variables['device']).grid(row=4, column=3, padx=10, pady=5, sticky="ew")

        # --- Section 4: Trimming ---
        self.create_header("Video Trimming", 5)

        ctk.CTkLabel(self, text="Start:").grid(row=6, column=0, padx=(20, 10), pady=5, sticky="w")
        ctk.CTkEntry(self, textvariable=variables['start_time'], placeholder_text="00:00:00").grid(row=6, column=1, padx=10, pady=5, sticky="ew")
        
        ctk.CTkLabel(self, text="End:").grid(row=6, column=2, padx=(20, 10), pady=5, sticky="w")
        ctk.CTkEntry(self, textvariable=variables['end_time'], placeholder_text="Leave empty for end").grid(row=6, column=3, padx=10, pady=5, sticky="ew")

        # --- Section 5: Visualization & Output ---
        self.create_header("Output Options", 7)

        viz_types = ["all", "cut", "both", "data", "trajectory"]
        ctk.CTkLabel(self, text="Viz Style:").grid(row=8, column=0, padx=(20, 10), pady=5, sticky="w")
        ctk.CTkComboBox(self, values=viz_types, variable=variables['viz_type']).grid(row=8, column=1, padx=10, pady=5, sticky="ew")

        # Group Checkboxes in a Frame for better alignment
        check_frame = ctk.CTkFrame(self, fg_color="transparent")
        check_frame.grid(row=9, column=0, columnspan=4, pady=(10, 0), sticky="ew")
        
        ctk.CTkCheckBox(check_frame, text="Keep CSVs", variable=variables['keep_all']).pack(side="left", padx=20)
        ctk.CTkCheckBox(check_frame, text="Visualize on Early Stop", variable=variables['viz_early']).pack(side="left", padx=20)

    def create_header(self, text, row):
        """Helper to create section dividers"""
        lbl = ctk.CTkLabel(self, text=text, font=ctk.CTkFont(size=13, weight="bold"), text_color="#1f538d")
        lbl.grid(row=row, column=0, columnspan=4, padx=10, pady=(15, 5), sticky="w")

    def browse_csv(self):
        path = filedialog.askopenfilename(filetypes=[("CSV files", "*.csv")])
        if path: self.csv_entry.delete(0, 'end'); self.csv_entry.insert(0, path)