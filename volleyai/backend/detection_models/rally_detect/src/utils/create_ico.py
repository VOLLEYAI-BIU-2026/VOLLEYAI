# src/utils/create_ico.py

from PIL import Image

def create_ico(input_path, output_path):
    # Open the generated image
    img = Image.open(input_path)
    
    # Define the standard icon sizes for Windows
    # (16x16, 32x32, 48x48, 64x64, 128x128, 256x256)
    icon_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    
    # Save as .ico with all sizes embedded
    img.save(output_path, format='ICO', sizes=icon_sizes)
    print(f"Icon saved successfully to {output_path}")

# Run the function
create_ico("./assets/installer_logo.png", "./assets/installer_logo.ico")