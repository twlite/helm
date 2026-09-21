// SPDX-License-Identifier: MIT
//
// Tiny Linux guest-side bridge for Helm's Virtio socket transport.
// It accepts one AF_VSOCK stream at a time and forwards it to the local
// helm-guest HTTP server. It intentionally exposes no command execution or
// host filesystem access.

#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <getopt.h>
#include <linux/vm_sockets.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define BUFFER_SIZE (64 * 1024)

static volatile sig_atomic_t stopping = 0;

static void stop_handler(int signal_number) {
  (void)signal_number;
  stopping = 1;
}

static void usage(const char *program) {
  fprintf(stderr,
          "Usage: %s [--vsock-port N] [--tcp-host IP] [--tcp-port N]\n",
          program);
}

static bool parse_port(const char *value, uint32_t *port) {
  char *end = NULL;
  unsigned long parsed = strtoul(value, &end, 10);
  if (value[0] == '\0' || end == NULL || *end != '\0' || parsed == 0 || parsed > 65535) {
    return false;
  }
  *port = (uint32_t)parsed;
  return true;
}

static int open_vsock_listener(uint32_t port) {
  int listener = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (listener < 0) {
    perror("socket(AF_VSOCK)");
    return -1;
  }

  struct sockaddr_vm address;
  memset(&address, 0, sizeof(address));
  address.svm_family = AF_VSOCK;
  address.svm_cid = VMADDR_CID_ANY;
  address.svm_port = port;

  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0) {
    perror("bind(AF_VSOCK)");
    close(listener);
    return -1;
  }
  if (listen(listener, 8) < 0) {
    perror("listen(AF_VSOCK)");
    close(listener);
    return -1;
  }
  return listener;
}

static int open_tcp_connection(const char *host, uint32_t port) {
  int connection = socket(AF_INET, SOCK_STREAM, 0);
  if (connection < 0) {
    perror("socket(AF_INET)");
    return -1;
  }

  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  if (inet_pton(AF_INET, host, &address.sin_addr) != 1) {
    fprintf(stderr, "Invalid TCP host address: %s\n", host);
    close(connection);
    return -1;
  }

  if (connect(connection, (struct sockaddr *)&address, sizeof(address)) < 0) {
    perror("connect(helm-guest)");
    close(connection);
    return -1;
  }
  return connection;
}

static bool send_all(int descriptor, const unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = send(descriptor, buffer + offset, length - offset, MSG_NOSIGNAL);
    if (written < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (written == 0) return false;
    offset += (size_t)written;
  }
  return true;
}

static void bridge_connection(int vsock, const char *tcp_host, uint32_t tcp_port) {
  int tcp = open_tcp_connection(tcp_host, tcp_port);
  if (tcp < 0) {
    close(vsock);
    return;
  }

  unsigned char buffer[BUFFER_SIZE];
  bool vsock_open = true;
  bool tcp_open = true;

  while (!stopping && (vsock_open || tcp_open)) {
    struct pollfd descriptors[2] = {
        {.fd = vsock, .events = vsock_open ? POLLIN : 0, .revents = 0},
        {.fd = tcp, .events = tcp_open ? POLLIN : 0, .revents = 0},
    };

    int ready = poll(descriptors, 2, 1000);
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (ready == 0) continue;

    if (vsock_open && (descriptors[0].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t received = recv(vsock, buffer, sizeof(buffer), 0);
      if (received <= 0) {
        vsock_open = false;
        tcp_open = false;
      } else if (!send_all(tcp, buffer, (size_t)received)) {
        vsock_open = false;
        tcp_open = false;
      }
    }

    if (tcp_open && (descriptors[1].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t received = recv(tcp, buffer, sizeof(buffer), 0);
      if (received <= 0) {
        tcp_open = false;
        vsock_open = false;
      } else if (!send_all(vsock, buffer, (size_t)received)) {
        vsock_open = false;
        tcp_open = false;
      }
    }
  }

  close(tcp);
  close(vsock);
}

int main(int argc, char **argv) {
  uint32_t vsock_port = 4242;
  uint32_t tcp_port = 4242;
  const char *tcp_host = "127.0.0.1";

  static const struct option options[] = {
      {"vsock-port", required_argument, NULL, 'v'},
      {"tcp-host", required_argument, NULL, 'h'},
      {"tcp-port", required_argument, NULL, 't'},
      {"help", no_argument, NULL, 'q'},
      {NULL, 0, NULL, 0}
  };

  int option;
  while ((option = getopt_long(argc, argv, "v:h:t:q", options, NULL)) != -1) {
    switch (option) {
      case 'v':
        if (!parse_port(optarg, &vsock_port)) {
          fprintf(stderr, "Invalid --vsock-port: %s\n", optarg);
          return EXIT_FAILURE;
        }
        break;
      case 'h':
        tcp_host = optarg;
        break;
      case 't':
        if (!parse_port(optarg, &tcp_port)) {
          fprintf(stderr, "Invalid --tcp-port: %s\n", optarg);
          return EXIT_FAILURE;
        }
        break;
      case 'q':
        usage(argv[0]);
        return EXIT_SUCCESS;
      default:
        usage(argv[0]);
        return EXIT_FAILURE;
    }
  }

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = stop_handler;
  sigemptyset(&action.sa_mask);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGTERM, &action, NULL);

  int listener = open_vsock_listener(vsock_port);
  if (listener < 0) return EXIT_FAILURE;

  fprintf(stderr, "helm-vsock-bridge listening on port %u -> %s:%u\n",
          vsock_port, tcp_host, tcp_port);

  while (!stopping) {
    int connection = accept(listener, NULL, NULL);
    if (connection < 0) {
      if (errno == EINTR) continue;
      perror("accept(AF_VSOCK)");
      break;
    }
    bridge_connection(connection, tcp_host, tcp_port);
  }

  close(listener);
  return EXIT_SUCCESS;
}
