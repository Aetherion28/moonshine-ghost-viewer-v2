# The PC side of wiiprobe (standard library only): hands the console the jobs put in a folder and saves its answers.
#   python server.py [folder]        (folder: where the jobs live; default: this script's own)
# In the folder:
#   jobs/NAME.job          a script to run (put there under another name and renamed: a file is taken whole)
#   answers/NAME.answer    its answer, once the console has sent all of it
#   done/NAME.job          the job afterwards; failed/NAME.job if the connection ended during it (it is not tried again)
#   server.txt             what the console needs on its SD card (apps/wiiprobe/server.txt): this PC's address, the port, the key
#   key.txt                the key (made on the first run; the console takes jobs only from a server that has it)
#   status.json, log.txt   what the server last saw, and its history
#   crashes.txt            what the console wrote before it restarted itself (a job that hung): what it was doing, the GPU's state
# A failed job keeps what the console had sent (failed/NAME.partial): its last record of kind 103 names the case it was in.
# Only addresses of a home network may connect; a new connection from the console replaces the old one (it restarted).
import hashlib, json, os, secrets, socket, struct, sys, threading, time

PORT = 4300
W = lambda s: struct.unpack('>I', s)[0]

class Server:
    def __init__(self, folder):
        self.folder = folder
        for d in ('jobs', 'answers', 'done', 'failed'): os.makedirs(os.path.join(folder, d), exist_ok=True)
        kp = os.path.join(folder, 'key.txt')
        if not os.path.exists(kp): open(kp, 'w').write(secrets.token_hex(16))
        self.key = open(kp).read().strip()
        self.status = dict(started=time.strftime('%Y-%m-%d %H:%M:%S'), console=None, state='waiting for the console', jobs_done=0, jobs_failed=0)
        self.ip = self.lan_address()
        open(os.path.join(folder, 'server.txt'), 'w', newline='\n').write(f'host={self.ip}\nport={PORT}\nkey={self.key}\n')
        self.save()

    def lan_address(self):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try: s.connect(('192.168.255.254', 9)); return s.getsockname()[0]      # (nothing is sent: this only asks which address the PC would use)
        except OSError: return '127.0.0.1'
        finally: s.close()

    def log(self, text):
        line = time.strftime('%Y-%m-%d %H:%M:%S ') + text
        print(line, flush=True)
        with open(os.path.join(self.folder, 'log.txt'), 'a') as f: f.write(line + '\n')

    def save(self):
        self.status['updated'] = time.strftime('%Y-%m-%d %H:%M:%S')
        tmp = os.path.join(self.folder, 'status.json.tmp')
        open(tmp, 'w').write(json.dumps(self.status, indent=1))
        os.replace(tmp, os.path.join(self.folder, 'status.json'))

    def next_job(self, wait):
        end = time.time() + wait
        while True:
            names = sorted(n for n in os.listdir(os.path.join(self.folder, 'jobs')) if n.endswith('.job'))
            if names: return names[0]
            if time.time() >= end: return None
            time.sleep(0.25)

    @staticmethod
    def private(ip):
        a = list(map(int, ip.split('.')))
        return a[0] in (10, 127) or (a[0] == 172 and 16 <= a[1] <= 31) or (a[0] == 192 and a[1] == 168)

    def serve(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(('0.0.0.0', PORT)); srv.listen(1)
        self.log(f'listening on {self.ip} port {PORT}; folder {self.folder}')
        self.log('the console needs server.txt (in this folder) as apps/wiiprobe/server.txt on its SD card')
        self.current = None
        while True:
            conn, (ip, _) = srv.accept()
            if not self.private(ip): self.log(f'refused {ip}: not a home network address'); conn.close(); continue
            conn.settimeout(120)
            threading.Thread(target=self.client, args=(conn, ip), daemon=True).start()

    def client(self, conn, ip):
        try:
            first = self.read(conn, 4)
            if first == b'CLWL':      # the console's last words before it restarts itself
                self.crash(self.read(conn, struct.unpack('>I', self.read(conn, 4))[0]).decode('latin-1'))
                return
            if first != b'CLW1': self.log(f'{ip} is not the console program'); return
            old, self.current = self.current, conn
            if old:
                try: old.shutdown(socket.SHUT_RDWR)
                except OSError: pass
            self.console(conn, ip, first + self.read(conn, 60))
        except (OSError, EOFError, struct.error) as e: self.log(f'the connection to {ip} ended: {e}')
        finally:
            conn.close()
            if self.current is conn: self.current = None; self.status['state'] = 'waiting for the console'; self.save()

    def crash(self, text):
        self.log('the console reports:\n' + text)
        with open(os.path.join(self.folder, 'crashes.txt'), 'a') as f: f.write(time.strftime('%Y-%m-%d %H:%M:%S\n') + text + '\n')
        self.status['last_crash'] = dict(at=time.strftime('%Y-%m-%d %H:%M:%S'), text=text); self.save()

    @staticmethod
    def read(conn, n):
        b = bytearray()
        while len(b) < n:
            p = conn.recv(min(65536, n - len(b)))
            if not p: raise EOFError('closed')
            b += p
        return bytes(b)

    def console(self, conn, ip, hello):
        magic, version, build, code, code_size, arena, arena_size, hollywood, cpu = struct.unpack('>9I', hello[:36])
        conn.sendall(b'CLS1' + hashlib.sha256(self.key.encode() + hello[48:64]).digest())
        self.status['console'] = dict(address=ip, version=version, build='%08x' % build, code='%08x' % code, code_size=code_size, arena='%08x' % arena, arena_size=arena_size, hollywood='%x' % hollywood, cpu='%x' % cpu, connected=time.strftime('%Y-%m-%d %H:%M:%S'))
        self.status['state'] = 'connected, idle'; self.save()
        self.log(f'console {ip}: version {version}, build {build:08x}')
        job_id = int(time.time()) & 0x7FFFFFFF
        while True:
            req = self.read(conn, 4)
            if req == b'LOG ':        # (kept on its card from before a restart)
                self.crash(self.read(conn, struct.unpack('>I', self.read(conn, 4))[0]).decode('latin-1')); continue
            if req != b'NEXT': raise EOFError('not a request')
            name = self.next_job(5)
            self.status['last_request'] = time.strftime('%Y-%m-%d %H:%M:%S')
            if not name:
                conn.sendall(b'IDLE'); self.save(); continue
            path = os.path.join(self.folder, 'jobs', name); stem = name[:-4]
            data = open(path, 'rb').read(); job_id += 1
            self.status['state'] = f'running {name}'; self.save(); self.log(f'job {name}: {len(data)} bytes')
            t0 = time.time(); answer = bytearray(); sent = []
            def send():
                try: conn.sendall(b'JOB ' + struct.pack('>II', job_id, len(data)) + data); sent.append(True)
                except OSError as e: sent.append(e)
            th = threading.Thread(target=send, daemon=True); th.start()
            try:
                while True:
                    kind = self.read(conn, 4)
                    if kind == b'DATA': answer += self.read(conn, struct.unpack('>I', self.read(conn, 4))[0])
                    elif kind == b'DONE':
                        jid, quit = struct.unpack('>II', self.read(conn, 8))
                        if jid != job_id: raise EOFError('an answer to another job')
                        break
                    else: raise EOFError('not an answer')
                th.join()
            except (OSError, EOFError) as e:
                os.replace(path, os.path.join(self.folder, 'failed', name))
                if answer: open(os.path.join(self.folder, 'failed', stem + '.partial'), 'wb').write(answer)
                self.status['jobs_failed'] += 1; self.log(f'job {name} failed after {time.time() - t0:.1f} s ({len(answer)} bytes of answer): {e}')
                raise
            tmp = os.path.join(self.folder, 'answers', stem + '.part')
            open(tmp, 'wb').write(answer)
            os.replace(tmp, os.path.join(self.folder, 'answers', stem + '.answer'))
            os.replace(path, os.path.join(self.folder, 'done', name))
            self.status['jobs_done'] += 1; self.status['state'] = 'connected, idle'; self.status['last_job'] = dict(name=name, seconds=round(time.time() - t0, 1), answer=len(answer)); self.save()
            self.log(f'job {name} done in {time.time() - t0:.1f} s: {len(answer)} bytes of answer')
            if quit: self.log('the job told the console to leave or restart'); return

if __name__ == '__main__':
    Server(os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))).serve()
