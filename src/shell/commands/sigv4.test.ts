import { describe, expect, it } from 'vitest'
import { awsUriEncode, deriveSignature, signRequest } from './sigv4'

describe('sigv4 deriveSignature', () => {
  it('matches the botocore reference vector', async () => {
    // produced by `aws s3api get-object --debug` with the AWS doc credentials;
    // the StringToSign and signature are botocore's own output
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20261024T035435Z',
      '20261024/us-east-1/s3/aws4_request',
      'b0a66116e51325e265aeba9792fb28fbd93e4f03e39eb9fcd3741187811b8112',
    ].join('\n')
    const signature = await deriveSignature(
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      '20261024',
      'us-east-1',
      's3',
      stringToSign,
    )
    expect(signature).toBe('50b4e34f7d7f3847a13bb70cb560596f4de73210df8a8b5c960fb6d48ba30883')
  })
})

describe('sigv4 signRequest', () => {
  it('signs a simple GET deterministically', async () => {
    const first = await signRequest({
      method: 'GET',
      canonicalPath: '/cell-bucket/cell/workspace.tar.gz',
      canonicalQuery: '',
      host: 'storage.example.com',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      amzDate: '20261024T000000Z',
      dateStamp: '20261024',
      region: 'auto',
      service: 's3',
      accessKeyId: 'KEY',
      secretAccessKey: 'SECRET',
    })
    expect(first.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=KEY\/20261024\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    const second = await signRequest({
      method: 'GET',
      canonicalPath: '/cell-bucket/cell/workspace.tar.gz',
      canonicalQuery: '',
      host: 'storage.example.com',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      amzDate: '20261024T000000Z',
      dateStamp: '20261024',
      region: 'auto',
      service: 's3',
      accessKeyId: 'KEY',
      secretAccessKey: 'SECRET',
    })
    expect(second.authorization).toBe(first.authorization)
  })
})

describe('awsUriEncode', () => {
  it('keeps unreserved characters and encodes the rest per AWS rules', () => {
    expect(awsUriEncode('a-b_c.d~e/f', false)).toBe('a-b_c.d~e/f')
    expect(awsUriEncode('a/b', true)).toBe('a%2Fb')
    expect(awsUriEncode('héllo +&=')).toBe('h%C3%A9llo%20%2B%26%3D')
  })
})
