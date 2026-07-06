# src/utils/utils.py

import sys
import os
import subprocess

CREATE_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def get_resource_path(relative_path):
    """
    Resolves the absolute path to an internal resource for both dev and production.

    This function handles the path discrepancy created when bundling a Python app into 
    a single-file executable. In production (PyInstaller), assets are extracted to 
    a temporary folder. In development, assets reside in the project's root directory.

    Args:
        relative_path (str): The path to the asset relative to the project root 
            (e.g., 'models/ball_detection/model.xml').

    Returns:
        str: The absolute filesystem path to the requested resource.
    """
    try:
        # PyInstaller creates a temporary folder and stores the path in _MEIPASS 
        # when the bundled executable is launched.
        base_path = sys._MEIPASS
    except AttributeError:
        # DEVELOPMENT MODE:
        # If _MEIPASS doesn't exist, we are running as a standard script.
        # This file is located at project_root/src/utils/utils.py
        # Go up three levels: utils.py -> src/ -> project_root/
        base_path = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        print(f"Development mode: base path set to {base_path}")

    return os.path.join(base_path, relative_path)


def get_bin_path(command=""):
    # If running as a PyInstaller bundle
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'bin/' + command +'.exe')
    # If running in development
    return command