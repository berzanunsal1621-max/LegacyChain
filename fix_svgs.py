import codecs
import re

with codecs.open('index.html', 'r', 'utf-8') as f:
    text = f.read()

# Replace Logo SVGs (with hexagon-clip)
logo_pattern = re.compile(r'<svg[^>]*hexagon-clip[^>]*>.*?</svg>', re.DOTALL)
logo_img = '<img src="logo.png" alt="LegacyChain Logo" className="h-10 w-auto object-contain hexagon-clip relative z-10" />'
text, count1 = re.subn(logo_pattern, logo_img, text)

# Replace Shield SVG
shield_pattern = re.compile(r'<svg[^>]*viewBox="0 0 200 200"[^>]*>.*?</svg>', re.DOTALL)
shield_img = '<img src="security_shield.png" alt="Security Shield" className="relative z-10 w-full h-full object-contain drop-shadow-[0_20px_50px_rgba(59,130,246,0.4)] hover:scale-105 transition duration-500" />'
text, count2 = re.subn(shield_pattern, shield_img, text)

with codecs.open('index.html', 'w', 'utf-8') as f:
    f.write(text)

print(f"Replaced {count1} logo SVGs and {count2} shield SVGs.")
