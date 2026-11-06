"""A separate GTK app for the desktop test to select text with the mouse."""
import json
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk

state_file = Path(sys.argv[1])
window = Gtk.Window(title="Anywhere Plamo selection test source")
window.set_default_size(560, 100)
window.move(50, 50)
entry = Gtk.Entry()
entry.set_text(sys.argv[2] if len(sys.argv) > 2 else "Please open the window.")
entry.set_margin_start(24)
entry.set_margin_end(24)
entry.set_margin_top(24)
entry.set_margin_bottom(24)
window.add(entry)


def report(*_):
    bounds = entry.get_selection_bounds()
    allocation = entry.get_allocation()
    data = {
        "selected": entry.get_text()[bounds[0]:bounds[1]] if bounds else "",
        "x": allocation.x,
        "y": allocation.y,
        "width": allocation.width,
        "height": allocation.height,
    }
    temporary = state_file.with_suffix(".tmp")
    temporary.write_text(json.dumps(data))
    temporary.replace(state_file)
    return False


entry.connect("notify::selection-bound", report)
entry.connect("notify::cursor-position", report)
window.connect("destroy", Gtk.main_quit)
window.show_all()
entry.set_position(-1)
GLib.idle_add(report)
Gtk.main()
