// Shared by the real bridge and the opt-in offline runtime acceptance command.
// This confines ordinary Python library configuration, not malicious native code.
export const PDF2ZH_PRIVATE_BOOTSTRAP = String.raw`
import os,tempfile
from pathlib import Path
os.umask(0o077)
# httpx/urllib can discover macOS system proxies even with spawn(env={}).
# Suppress that fallback for this child, not the user's machine or Host.
# The bridge's socket allowlist still permits only its exact loopback port.
os.environ["NO_PROXY"]="*"
work=Path.cwd().resolve()
private_home=work/"private-home"
private_home.mkdir(parents=True,exist_ok=True)
Path.home=classmethod(lambda cls:private_home)
def private_expanduser(value):
    # pathlib.expanduser() calls os.path.expanduser(), NOT Path.home(). Never
    # set or inherit HOME, and never resolve another OS user's home directory.
    is_bytes=isinstance(value,bytes)
    text=os.fsdecode(value)
    if text=="~": result=str(private_home)
    elif text.startswith("~/"):
        resolved=(private_home/text[2:]).resolve()
        if not resolved.is_relative_to(private_home): raise ValueError("private_home_escape_not_allowed")
        result=str(resolved)
    elif text.startswith("~"): raise ValueError("other_user_home_not_allowed")
    else: result=text
    return os.fsencode(result) if is_bytes else result
os.path.expanduser=private_expanduser
temporary=work/"private-tmp"
temporary.mkdir(parents=True,exist_ok=True)
tempfile.tempdir=str(temporary)
for name,folder in (("XDG_CONFIG_HOME",".config"),("XDG_CACHE_HOME",".cache"),("XDG_DATA_HOME",".local/share"),
                    ("XDG_STATE_HOME",".local/state"),("MPLCONFIGDIR",".cache/matplotlib")):
    location=private_home/folder
    location.mkdir(parents=True,exist_ok=True)
    os.environ[name]=str(location)
`;
