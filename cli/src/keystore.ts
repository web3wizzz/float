import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export interface KeystoreFile {
  version: 1;
  address: string;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export function encryptKey(privateKey: string, password: string, address: string): KeystoreFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return {
    version: 1,
    address,
    kdf: "scrypt",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
}

export function decryptKey(file: KeystoreFile, password: string): string {
  try {
    const key = scryptSync(password, Buffer.from(file.salt, "hex"), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
    decipher.setAuthTag(Buffer.from(file.tag, "hex"));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, "hex")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new Error("Could not unlock the keystore.");
  }
}
