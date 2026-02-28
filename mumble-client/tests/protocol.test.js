/**
 * Protocol tests — verify Mumble protobuf encoding/decoding and TCP framing.
 * Written BEFORE implementation (TDD).
 */
const { expect } = require('chai');
const path = require('path');

// The module under test
const MumbleProtocol = require('../src/mumble/protocol');

describe('MumbleProtocol', () => {
  let proto;

  before(async () => {
    proto = new MumbleProtocol();
    await proto.init(path.join(__dirname, '..', 'proto', 'Mumble.proto'));
  });

  describe('init()', () => {
    it('should load protobuf definitions', () => {
      expect(proto.types).to.be.an('object');
      expect(proto.types).to.have.property('Version');
      expect(proto.types).to.have.property('Authenticate');
      expect(proto.types).to.have.property('ServerSync');
      expect(proto.types).to.have.property('Ping');
      expect(proto.types).to.have.property('ChannelState');
      expect(proto.types).to.have.property('UserState');
      expect(proto.types).to.have.property('TextMessage');
      expect(proto.types).to.have.property('UDPTunnel');
    });
  });

  describe('encodeMessage()', () => {
    it('should encode a Version message with TCP framing', () => {
      const buf = proto.encodeMessage('Version', {
        versionV1: (1 << 16) | (2 << 8) | 4,
        release: 'TestClient 1.0',
        os: 'Test',
        osVersion: 'Test',
      });
      expect(buf).to.be.instanceOf(Buffer);
      // Mumble framing: 2 bytes type + 4 bytes length + payload
      expect(buf.length).to.be.greaterThan(6);
      // Type 0 = Version
      expect(buf.readUInt16BE(0)).to.equal(0);
      const payloadLen = buf.readUInt32BE(2);
      expect(buf.length).to.equal(6 + payloadLen);
    });

    it('should encode an Authenticate message', () => {
      const buf = proto.encodeMessage('Authenticate', {
        username: 'testuser',
        opus: true,
      });
      expect(buf).to.be.instanceOf(Buffer);
      expect(buf.readUInt16BE(0)).to.equal(2); // Type 2 = Authenticate
    });

    it('should encode a Ping message', () => {
      const buf = proto.encodeMessage('Ping', { timestamp: Date.now() });
      expect(buf).to.be.instanceOf(Buffer);
      expect(buf.readUInt16BE(0)).to.equal(3); // Type 3 = Ping
    });

    it('should encode a UserState message for channel move', () => {
      const buf = proto.encodeMessage('UserState', {
        session: 5,
        channelId: 12,
      });
      expect(buf).to.be.instanceOf(Buffer);
      expect(buf.readUInt16BE(0)).to.equal(9); // Type 9 = UserState
    });

    it('should encode a TextMessage', () => {
      const buf = proto.encodeMessage('TextMessage', {
        channelId: [1],
        message: 'Hello world',
      });
      expect(buf).to.be.instanceOf(Buffer);
      expect(buf.readUInt16BE(0)).to.equal(11); // Type 11 = TextMessage
    });
  });

  describe('parseMessages()', () => {
    it('should parse a single complete message from a buffer', () => {
      const encoded = proto.encodeMessage('Ping', { timestamp: 12345 });
      const messages = proto.parseMessages(encoded);
      expect(messages).to.be.an('array').with.lengthOf(1);
      expect(messages[0].type).to.equal(3); // Ping
      expect(messages[0].payload).to.be.instanceOf(Buffer);
    });

    it('should parse multiple messages from a single buffer', () => {
      const msg1 = proto.encodeMessage('Ping', { timestamp: 111 });
      const msg2 = proto.encodeMessage('Ping', { timestamp: 222 });
      const combined = Buffer.concat([msg1, msg2]);
      const messages = proto.parseMessages(combined);
      expect(messages).to.be.an('array').with.lengthOf(2);
    });

    it('should return remainder when buffer has incomplete message', () => {
      const encoded = proto.encodeMessage('Ping', { timestamp: 12345 });
      // Cut off last 2 bytes to simulate incomplete data
      const partial = encoded.slice(0, encoded.length - 2);
      const messages = proto.parseMessages(partial);
      expect(messages).to.be.an('array').with.lengthOf(0);
      expect(proto.getRemainder()).to.have.length.greaterThan(0);
    });

    it('should reassemble split messages across calls', () => {
      const encoded = proto.encodeMessage('Ping', { timestamp: 999 });
      const part1 = encoded.slice(0, 4);
      const part2 = encoded.slice(4);

      proto.resetRemainder();
      const msgs1 = proto.parseMessages(part1);
      expect(msgs1).to.have.lengthOf(0);

      const msgs2 = proto.parseMessages(part2);
      expect(msgs2).to.have.lengthOf(1);
      expect(msgs2[0].type).to.equal(3);
    });
  });

  describe('decodePayload()', () => {
    it('should decode a Ping payload', () => {
      const encoded = proto.encodeMessage('Ping', { timestamp: 98765 });
      const messages = proto.parseMessages(encoded);
      const decoded = proto.decodePayload('Ping', messages[0].payload);
      // protobufjs uses Long for uint64, so we compare as number
      expect(Number(decoded.timestamp)).to.equal(98765);
    });

    it('should decode a ChannelState payload', () => {
      const encoded = proto.encodeMessage('ChannelState', {
        channelId: 5,
        parent: 0,
        name: 'General',
      });
      const messages = proto.parseMessages(encoded);
      const decoded = proto.decodePayload('ChannelState', messages[0].payload);
      expect(decoded.channelId).to.equal(5);
      expect(decoded.name).to.equal('General');
      expect(decoded.parent).to.equal(0);
    });

    it('should decode a UserState payload', () => {
      const encoded = proto.encodeMessage('UserState', {
        session: 42,
        name: 'alice',
        channelId: 3,
      });
      const messages = proto.parseMessages(encoded);
      const decoded = proto.decodePayload('UserState', messages[0].payload);
      expect(decoded.session).to.equal(42);
      expect(decoded.name).to.equal('alice');
      expect(decoded.channelId).to.equal(3);
    });

    it('should decode a TextMessage payload', () => {
      const encoded = proto.encodeMessage('TextMessage', {
        channelId: [7],
        message: 'Hello from test',
      });
      const messages = proto.parseMessages(encoded);
      const decoded = proto.decodePayload('TextMessage', messages[0].payload);
      expect(decoded.message).to.equal('Hello from test');
      expect(decoded.channelId).to.include(7);
    });

    it('should decode a ServerSync payload', () => {
      const encoded = proto.encodeMessage('ServerSync', {
        session: 10,
        welcomeText: 'Welcome!',
      });
      const messages = proto.parseMessages(encoded);
      const decoded = proto.decodePayload('ServerSync', messages[0].payload);
      expect(decoded.session).to.equal(10);
      expect(decoded.welcomeText).to.equal('Welcome!');
    });
  });

  describe('MSG_TYPE constants', () => {
    it('should have correct numeric type IDs', () => {
      expect(MumbleProtocol.MSG_TYPE.Version).to.equal(0);
      expect(MumbleProtocol.MSG_TYPE.UDPTunnel).to.equal(1);
      expect(MumbleProtocol.MSG_TYPE.Authenticate).to.equal(2);
      expect(MumbleProtocol.MSG_TYPE.Ping).to.equal(3);
      expect(MumbleProtocol.MSG_TYPE.ServerSync).to.equal(5);
      expect(MumbleProtocol.MSG_TYPE.ChannelState).to.equal(7);
      expect(MumbleProtocol.MSG_TYPE.UserState).to.equal(9);
      expect(MumbleProtocol.MSG_TYPE.TextMessage).to.equal(11);
      expect(MumbleProtocol.MSG_TYPE.CryptSetup).to.equal(15);
      expect(MumbleProtocol.MSG_TYPE.UserRemove).to.equal(8);
      expect(MumbleProtocol.MSG_TYPE.ChannelRemove).to.equal(6);
    });
  });
});
