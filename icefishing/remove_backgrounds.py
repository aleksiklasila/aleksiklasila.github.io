import os
from PIL import Image

def process_images(directory):
    for filename in os.listdir(directory):
        if filename.endswith(".png"):
            filepath = os.path.join(directory, filename)
            try:
                # Open the image and ensure it has an alpha channel (RGBA)
                img = Image.open(filepath).convert("RGBA")
                data = img.getdata()

                new_data = []
                for item in data:
                    r, g, b, a = item
                    # Check for the near-magenta background: r >= 240, g <= 5, b >= 240
                    if r >= 200 and g <= 150 and b >= 200:
                        # Set alpha to 0 (fully transparent)
                        new_data.append((r, g, b, 0))
                    else:
                        new_data.append(item)

                # Update the image with the new data
                img.putdata(new_data)
                
                # Save it back out (overwriting the original)
                img.save(filepath, "PNG")
                print(f"Processed: {filename}")
            except Exception as e:
                print(f"Error processing {filename}: {e}")

if __name__ == "__main__":
    assets_dir = os.path.join(os.path.dirname(__file__), "assets")
    if os.path.exists(assets_dir):
        print(f"Processing images in: {assets_dir}")
        process_images(assets_dir)
        print("Done!")
    else:
        print(f"Assets directory not found at: {assets_dir}")
