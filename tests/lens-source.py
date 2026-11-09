"""A separate GTK window with raster text for the real OCR lens test."""
import json
import sys
from pathlib import Path

import cairo
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
marker = Gtk.Image()
fixed.put(marker, 0, 0)
window.add(fixed)
window.connect("destroy", Gtk.main_quit)
window.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.SCROLL_MASK)
inputs = {'clicks': 0, 'scrolls': 0}


def record_input(_window, _event, kind):
    inputs[kind] += 1
    temporary = state_file.with_suffix('.input.tmp')
    temporary.write_text(json.dumps(inputs))
    temporary.replace(state_file.with_suffix('.input.json'))
    return False


window.connect('button-press-event', record_input, 'clicks')
window.connect('scroll-event', record_input, 'scrolls')
state_file.with_suffix('.input.json').write_text(json.dumps(inputs))
mode = None
frame = 0


def update():
    global mode, frame
    command = json.loads(state_file.read_text())
    value = command['mode']
    if mode != value:
        mode = value
        marker.clear()
        if mode == 'blank':
            image.clear()
        elif mode == 'comic':
            image.set_from_file(command['path'])
        elif mode.startswith('layout'):
            # Rasterize soft-wrapped paragraphs; these are not selectable GTK text.
            surface = cairo.ImageSurface(cairo.FORMAT_RGB24, 620, 260)
            context = cairo.Context(surface)
            context.set_source_rgb(1, 1, 1)
            context.paint()
            context.set_source_rgb(0, 0, 0)
            context.select_font_face('DejaVu Sans')
            context.set_font_size(20)
            for y, line in [(40, 'This paragraph continues'), (68, 'on the next line.'),
                            (145, 'Resize the lens to let this translation use more space'),
                            (173, 'without keeping the original line breaks.')]:
                context.move_to(24, y)
                context.show_text(line)
            path = state_file.with_name('lens-layout-source.png')
            surface.write_to_png(str(path))
            image.set_from_file(str(path))
            if 'bar' in command:
                height = 16 if mode == 'layout-footer' else 30
                surface = cairo.ImageSurface(cairo.FORMAT_RGB24, 260, height)
                context = cairo.Context(surface)
                context.set_source_rgb(1, 1, 1)
                context.paint()
                context.set_source_rgb(0, 0, 0)
                context.set_font_size(11 if mode == 'layout-footer' else 20)
                context.move_to(4, height - 5)
                context.show_text('Footer edge text' if mode == 'layout-bottom' else 'Toolbar text changed')
                path = state_file.with_name('lens-marker.png')
                surface.write_to_png(str(path))
                marker.set_from_file(str(path))
                _, x, y = window.get_window().get_origin()
                fixed.move(marker, command['bar'][0] - x, command['bar'][1] - y)
        else:
            image.set_from_file(str(fixtures / f"ocr-{'english' if mode == 'animated' else mode}.png"))
        window.queue_draw()
        GLib.timeout_add(100, report)
    if mode == 'animated':
        # Change every frame so exact-image matching cannot mistake this for a pause.
        frame = (frame + 1) % 256
        surface = cairo.ImageSurface(cairo.FORMAT_RGB24, 6, 6)
        context = cairo.Context(surface)
        context.set_source_rgb(frame / 255, 0, 0)
        context.paint()
        path = state_file.with_name('lens-marker.png')
        surface.write_to_png(str(path))
        marker.set_from_file(str(path))
        fixed.move(marker, 870, 400)
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
