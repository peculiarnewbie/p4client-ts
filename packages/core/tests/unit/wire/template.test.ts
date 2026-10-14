import { describe, expect, it } from 'bun:test';
import { matchTemplate } from '../../../src/wire/template.js';

describe('matchTemplate', () => {
  it('recovers plain arguments', () => {
    expect(matchTemplate("Can't clobber writable file %file%", "Can't clobber writable file C:\\ws\\a.txt\n"))
      .toEqual({ file: 'C:\\ws\\a.txt' });
  });

  it('takes the first branch of a conditional when its argument is present', () => {
    expect(matchTemplate('[%argc% - no|No] such file(s).', '//depot/a.txt - no such file(s).'))
      .toEqual({ argc: '//depot/a.txt' });
  });

  it('takes the second branch when the argument is absent', () => {
    expect(matchTemplate('[%argc% - no|No] such file(s).', 'No such file(s).')).toEqual({});
  });

  it('treats a conditional without an alternative as optional text', () => {
    const template = "%depotFile% - can't %action% exclusive file already opened[ for %otherclntaction%]";
    expect(matchTemplate(template, "//d/a.uasset - can't edit exclusive file already opened for edit"))
      .toEqual({ depotFile: '//d/a.uasset', action: 'edit', otherclntaction: 'edit' });
    expect(matchTemplate(template, "//d/a.uasset - can't edit exclusive file already opened"))
      .toEqual({ depotFile: '//d/a.uasset', action: 'edit' });
  });

  it('prints quoted literals without their quotes', () => {
    expect(matchTemplate("Your session has expired, please %'login'% again.", 'Your session has expired, please login again.'))
      .toEqual({});
  });

  it('keeps a Windows drive colon inside an argument', () => {
    expect(matchTemplate('%operation%: %arg%: %errmsg%', 'open for write: C:\\ws\\a.txt: Access is denied. \n'))
      .toEqual({ operation: 'open for write', arg: 'C:\\ws\\a.txt', errmsg: 'Access is denied.' });
  });

  it('reports text that does not follow the template', () => {
    expect(matchTemplate('%path% - must refer to client %client%.', 'something else')).toBeNull();
  });

  it('rejects malformed templates', () => {
    expect(matchTemplate('[unclosed %x%', 'unclosed y')).toBeNull();
    expect(matchTemplate('%unterminated', 'x')).toBeNull();
  });
});
