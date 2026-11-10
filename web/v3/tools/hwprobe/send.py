# Talks to a Wii on the home network (standard library only).
#   python3 send.py <wii address> load build/boot.dol           give the Homebrew Channel (open, on its main screen) the program
#   python3 send.py <wii address> run <script.gxps> <answer.gxpo>   give the running program a script and save its answer
#   python3 send.py <wii address> quit                           make the program leave (back to the Homebrew Channel)
import socket, struct, sys, threading, zlib, os, time

def load(host, path):
    # the Homebrew Channel's own way of taking a program ("wiiload", TCP port 4299)
    data = open(path, 'rb').read(); packed = zlib.compress(data, 6); args = os.path.basename(path).encode() + b'\0'
    s = socket.create_connection((host, 4299), timeout=10)
    s.sendall(b'HAXX' + struct.pack('>BBHLL', 0, 5, len(args), len(packed), len(data)))
    s.sendall(packed); s.sendall(args); s.close()
    print('sent', len(data), 'bytes')

def run(host, script, answer_path, port=4300):
    s = socket.create_connection((host, port), timeout=20); s.settimeout(120)
    got = bytearray(); err = []
    def reader():
        try:
            while True:
                b = s.recv(65536)
                if not b: break
                got.extend(b)
        except Exception as e: err.append(e)
    t = threading.Thread(target=reader); t.start()
    t0 = time.time()
    for i in range(0, len(script), 65536): s.sendall(script[i:i + 65536])
    t.join()
    s.close()
    if answer_path: open(answer_path, 'wb').write(got)
    print('script', len(script), 'bytes; answer', len(got), 'bytes;', round(time.time() - t0, 1), 's', '; '.join(map(str, err)))
    return bytes(got)

if __name__ == '__main__':
    host, what = sys.argv[1], sys.argv[2]
    if what == 'load': load(host, sys.argv[3])
    elif what == 'run': run(host, open(sys.argv[3], 'rb').read(), sys.argv[4])
    elif what == 'quit': run(host, b'GXPS' + struct.pack('>III', 1, 0, 0) + struct.pack('>IIII', 10, 0, 0, 0) + struct.pack('>IIII', 0, 0, 0, 0), None)
