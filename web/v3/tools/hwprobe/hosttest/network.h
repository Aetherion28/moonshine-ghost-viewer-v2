static inline s32 if_config(char *ip, char *mask, char *gw, int dhcp, int tries) { strcpy(ip, "127.0.0.1"); return 0; }
#define net_socket socket
#define net_connect connect
#define net_recv recv
#define net_send(s, p, n, f) send(s, p, n, MSG_NOSIGNAL)
#define net_close close
