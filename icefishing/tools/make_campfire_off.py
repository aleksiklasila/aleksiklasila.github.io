from PIL import Image

def is_fire(r, g, b, a):
    if a == 0: return False
    
    # Yellow/Orange/Red fire colors
    if r > 180 and g > 80 and b < 100:
        return True
    
    # White-hot interior
    if r > 240 and g > 240 and b > 150:
        return True
        
    # Red-orange exterior
    if r > 200 and r > g * 1.5 and b < 100:
        return True
        
    # Bright Yellow 
    if r > 200 and g > 180 and b < 80:
        return True
        
    return False

try:
    img = Image.open('assets/campfire_anim.png').convert('RGBA')
except Exception as e:
    print(f"Error opening image: {e}")
    exit(1)

frame_w = img.width // 3
frame_h = img.height // 2

frame = img.crop((0, 0, frame_w, frame_h))
pixels = frame.load()

for y in range(frame_h):
    for x in range(frame_w):
        r, g, b, a = pixels[x, y]
        if is_fire(r, g, b, a):
            pixels[x, y] = (0, 0, 0, 0)
            
frame.save('assets/campfire_off.png')
print("Saved assets/campfire_off.png")
