"""A separate GTK window with raster text for the real OCR lens test."""
import json
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk

state_file = Path(sys.argv[1])
fixtures = Path(__file__).parent / "fixtures"
window = Gtk.Window(title="Anywhere Plamo OCR test source")
window.set_default_size(1100, 760)
window.move(20, 20)
style = Gtk.CssProvider()
style.load_from_data(b"window { background: white; color: black; }")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), style, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
fixed = Gtk.Fixed()
image = Gtk.Image()
fixed.put(image, 220, 200)
window.add(fixed)
window.connect("destroy", Gtk.main_quit)
mode = None


def update():
    global mode
    value = json.loads(state_file.read_text())['mode']
    if mode != value:
        mode = value
        if mode == 'blank':
            image.clear()
        else:
            image.set_from_file(str(fixtures / f"ocr-{mode}.png"))
        window.queue_draw()
        GLib.timeout_add(100, report)
    return True


def report():
    _, x, y = window.get_window().get_origin()
    temporary = state_file.with_suffix('.tmp')
    temporary.write_text(json.dumps({'mode': mode, 'x': x + 220, 'y': y + 200}))
    temporary.replace(state_file.with_suffix('.ready.json'))
    return False


window.show_all()
GLib.timeout_add(50, update)
Gtk.main()
